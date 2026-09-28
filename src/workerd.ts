import type { DurableObjectState } from "@cloudflare/workers-types"
import { Cause, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { config } from "./config.js"
import { motelApi } from "./httpServer.js"
import { AsyncIngest } from "./services/AsyncIngest.js"
import { IngestError } from "./services/ingestRpc.js"
import { makeTelemetryStoreEffect, TelemetryStoreReadonly, type TelemetryStore } from "./services/TelemetryStore.js"
import { workerdDatabase } from "./services/TelemetryStoreWorkerd.js"
import { TraceExport, LogExport } from "./otlpSchema.js"
import { decodeProtobufLogs, decodeProtobufTraces } from "./otlpProtobuf.js"
import documents from "motel:documents"
import pkg from "../package.json" with { type: "json" }

interface Env {
	readonly STORE: { getByName(name: string): { fetch(request: Request): Promise<Response> } }
	readonly ASSETS: { fetch(request: Request): Promise<Response> }
}

const health = () => ({
	ok: true,
	service: "motel-local-server",
	databasePath: config.otel.databasePath,
	pid: 0,
	url: config.otel.baseUrl,
	workdir: "/",
	startedAt: new Date().toISOString(),
	version: pkg.version,
})

const ingestPaths = new Set(["/v1/traces", "/v1/logs"])
const refusalLogInterval = 60_000

/** Read a body without a declared length, giving up once it exceeds `limit` bytes. */
const boundedText = async (request: Request, limit: number): Promise<string | undefined> => {
	if (request.body === null) return ""
	const reader = request.body.getReader()
	const decoder = new TextDecoder()
	let text = ""
	let bytes = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) return text + decoder.decode()
		bytes += value.byteLength
		if (bytes > limit) {
			await reader.cancel()
			return undefined
		}
		text += decoder.decode(value, { stream: true })
	}
}

/** Why the collector did not store an export. Each is counted; see `MotelCollector.ingestStatus`. */
type Loss = "queueFull" | "tooLarge" | "invalid" | "storeFailed"
const losses: ReadonlyArray<Loss> = ["queueFull", "tooLarge", "invalid", "storeFailed"]
interface LossCounts {
	/** Exports not stored, by reason. */
	readonly refused: Record<Loss, number>
	/** Declared bytes of those exports, where the request declared a length. */
	readonly refusedBytes: number
	readonly lastRefusedAt: string | null
}
const lossKey = "motel:ingest-losses"

/** One durable SQLite owner for OTLP ingestion, queries and bounded alarm maintenance. */
export class MotelCollector {
	private readonly state: DurableObjectState
	private readonly store: Promise<TelemetryStore["Service"]>
	private readonly handler: Promise<(request: Request) => Promise<Response>>
	/** Exports being read or stored now. Bounded by `maxPendingIngest`. */
	private pending = 0
	/**
	 * Exports the collector did not store. Kept in the actor's storage, so the counts survive
	 * eviction and restarts; `GET /api/ingest` reports them and a warning names them in the log.
	 */
	private losses: LossCounts
	private lastLossLog = 0

	constructor(state: DurableObjectState) {
		this.state = state
		const saved = state.storage.kv.get<LossCounts>(lossKey)
		this.losses = {
			refused: Object.fromEntries(losses.map((loss) => [loss, saved?.refused[loss] ?? 0])) as Record<Loss, number>,
			refusedBytes: saved?.refusedBytes ?? 0,
			lastRefusedAt: saved?.lastRefusedAt ?? null,
		}
		// The actor owns one connection and bootstrap. No native handle or detached fiber
		// escapes this scoped construction; durable alarms own subsequent maintenance.
		this.store = state.blockConcurrencyWhile(() =>
			Effect.runPromise(Effect.scoped(makeTelemetryStoreEffect(workerdDatabase(state.storage), { readonly: false, runRetention: false }))),
		)
		// A failed bootstrap is reported by each request that needs the store.
		this.store.catch(() => {})
		// One router for the actor's lifetime. Building the typed API per request allocates
		// far more than the request itself and leaves it for a later collection.
		this.handler = this.store.then((store) => {
			const ingest = Layer.succeed(AsyncIngest, {
				ingestTraces: ({ payload }) =>
					Schema.decodeUnknownEffect(TraceExport)(payload).pipe(
						Effect.mapError(() => new IngestError({ message: "Invalid trace payload" })),
						Effect.flatMap((parsed) =>
							store.ingestTraces(parsed).pipe(Effect.mapError(() => new IngestError({ message: "Trace storage failed" }))),
						),
					),
				ingestLogs: ({ payload }) =>
					Schema.decodeUnknownEffect(LogExport)(payload).pipe(
						Effect.mapError(() => new IngestError({ message: "Invalid log payload" })),
						Effect.flatMap((parsed) =>
							store.ingestLogs(parsed).pipe(Effect.mapError(() => new IngestError({ message: "Log storage failed" }))),
						),
					),
			})
			const { handler } = HttpRouter.toWebHandler(
				motelApi({ health, docs: documents }).pipe(
					HttpRouter.provideRequest(ingest),
					HttpRouter.provideRequest(Layer.succeed(TelemetryStoreReadonly, store)),
					Layer.provide(HttpServer.layerServices),
				),
				{ disableLogger: true },
			)
			return (request: Request) => handler(request)
		})
		this.handler.catch(() => {})
	}

	/** Serve through the same typed HTTP routes as the native collector. */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (request.method === "GET" && url.pathname === "/api/ingest") return Response.json(this.ingestStatus())
		if (request.method === "POST" && ingestPaths.has(url.pathname)) return this.ingest(request)
		return this.serve(request)
	}

	private async serve(request: Request): Promise<Response> {
		const handler = await this.handler
		if ((await this.state.storage.getAlarm()) === null) {
			await this.state.storage.setAlarm(Date.now() + config.otel.retentionIntervalSeconds * 1000)
		}
		return handler(request)
	}

	/**
	 * Accept an export only while the queue has room and only up to the size bound, so the
	 * collector's memory for exports never exceeds `maxPendingIngest * maxIngestBytes`. Every
	 * export it does not store is counted. OTLP exporters retry 429, 500 and 503 and drop 400
	 * and 413, so a malformed or oversized export is answered as final and a storage failure as
	 * transient.
	 */
	private async ingest(request: Request): Promise<Response> {
		const declared = request.headers.get("content-length")
		const bytes = declared === null ? 0 : Number(declared)
		if (bytes > config.otel.maxIngestBytes) {
			this.discard(request)
			return this.refuse("tooLarge", bytes, "Telemetry export exceeds the collector's size limit", 413)
		}
		if (this.pending >= config.otel.maxPendingIngest) {
			this.discard(request)
			return this.refuse("queueFull", bytes, "Collector ingest queue is full", 429, { "retry-after": "1" })
		}
		this.pending += 1
		try {
			const signal = new URL(request.url).pathname === "/v1/traces" ? "traces" : "logs"
			const protobuf = /application\/(x-)?protobuf/i.test(request.headers.get("content-type") ?? "")
			if (declared === null && protobuf) return Response.json({ error: "Protobuf exports need a Content-Length" }, { status: 411 })
			let payload: unknown
			try {
				if (declared === null) {
					const body = await boundedText(request, config.otel.maxIngestBytes)
					if (body === undefined) return this.refuse("tooLarge", 0, "Telemetry export exceeds the collector's size limit", 413)
					payload = JSON.parse(body)
				} else if (protobuf) {
					const bytes = new Uint8Array(await request.arrayBuffer())
					payload = signal === "traces" ? decodeProtobufTraces(bytes) : decodeProtobufLogs(bytes)
				} else {
					// Parsed from the body without keeping its text: a whole export is a large string,
					// and one held while it is stored outlives the young generation.
					payload = await request.json()
				}
			} catch (cause) {
				return this.refuse("invalid", bytes, `Invalid ${signal} export`, 400, {}, cause)
			}
			let store: TelemetryStore["Service"]
			try {
				store = await this.store
			} catch (cause) {
				return this.refuse("storeFailed", bytes, "Telemetry store is unavailable", 503, { "retry-after": "10" }, cause)
			}
			return await this.write(store, signal, payload, bytes)
		} finally {
			this.pending -= 1
		}
	}

	/** Store one decoded export. Spans and logs are written before the response is sent. */
	private async write(store: TelemetryStore["Service"], signal: "traces" | "logs", payload: unknown, bytes: number): Promise<Response> {
		let stored: Effect.Effect<unknown, unknown>
		if (signal === "traces") {
			const decoded = Schema.decodeUnknownExit(TraceExport)(payload)
			if (decoded._tag === "Failure") return this.refuse("invalid", bytes, "Invalid traces export", 400, {}, Cause.squash(decoded.cause))
			stored = store.ingestTraces(decoded.value)
		} else {
			const decoded = Schema.decodeUnknownExit(LogExport)(payload)
			if (decoded._tag === "Failure") return this.refuse("invalid", bytes, "Invalid logs export", 400, {}, Cause.squash(decoded.cause))
			stored = store.ingestLogs(decoded.value)
		}
		try {
			if ((await this.state.storage.getAlarm()) === null) {
				await this.state.storage.setAlarm(Date.now() + config.otel.retentionIntervalSeconds * 1000)
			}
			// Each export is stored before the response, then the size bound is held again.
			const result = await Effect.runPromise(Effect.tap(stored, () => store.holdSizeBound))
			return Response.json(result)
		} catch (cause) {
			return this.refuse("storeFailed", bytes, `The ${signal} export could not be stored`, 500, {}, cause)
		}
	}

	/** Discard an unread body; reading it is the work being refused. */
	private discard(request: Request) {
		request.body?.cancel().catch(() => {})
	}

	private refuse(
		loss: Loss,
		bytes: number,
		error: string,
		status: number,
		headers: Record<string, string> = {},
		cause?: unknown,
	): Response {
		this.losses = {
			refused: { ...this.losses.refused, [loss]: this.losses.refused[loss] + 1 },
			refusedBytes: this.losses.refusedBytes + bytes,
			lastRefusedAt: new Date().toISOString(),
		}
		this.state.storage.kv.put(lossKey, this.losses)
		const now = Date.now()
		// A storage failure is logged every time with its cause; refusals under load once a minute.
		if (loss === "storeFailed" || now - this.lastLossLog >= refusalLogInterval) {
			this.lastLossLog = now
			console.warn(
				JSON.stringify({
					message: "motel: telemetry exports not stored",
					reason: loss,
					...(cause === undefined ? {} : { cause: String(cause instanceof Error ? cause.message : cause) }),
					...this.ingestStatus(),
				}),
			)
		}
		return Response.json({ error }, { status, headers })
	}

	private ingestStatus() {
		return {
			pending: this.pending,
			maxPending: config.otel.maxPendingIngest,
			maxBytes: config.otel.maxIngestBytes,
			...this.losses,
		}
	}

	/** Repeat maintenance even when no ingest requests arrive. */
	async alarm(): Promise<void> {
		try {
			await Effect.runPromise((await this.store).runRetentionNow)
		} finally {
			await this.state.storage.setAlarm(Date.now() + config.otel.retentionIntervalSeconds * 1000)
		}
	}
}

const contentTypes: Readonly<Record<string, string>> = {
	js: "text/javascript",
	css: "text/css",
	html: "text/html",
	svg: "image/svg+xml",
	png: "image/png",
	ico: "image/x-icon",
}

/** workerd entry point. Health bypasses SQLite; API requests share the single durable writer. */
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === "/api/health") return Response.json(health())
		if (/^\/(api|v1|trace)(\/|$)/.test(url.pathname) || ["/openapi.json", "/docs"].includes(url.pathname)) {
			return env.STORE.getByName("collector").fetch(request)
		}
		let asset = await env.ASSETS.fetch(request)
		if (asset.status === 404 || url.pathname === "/") {
			url.pathname = "/index.html"
			asset = await env.ASSETS.fetch(new Request(url, request))
		}
		const headers = new Headers(asset.headers)
		headers.set("content-type", contentTypes[url.pathname.split(".").at(-1) ?? ""] ?? "application/octet-stream")
		return new Response(asset.body, { status: asset.status, headers })
	},
}
