import type { DurableObjectState } from "@cloudflare/workers-types"
import { Effect, Layer, Schema } from "effect"
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

/** One durable SQLite owner for OTLP ingestion, queries and bounded alarm maintenance. */
export class MotelCollector {
	private readonly state: DurableObjectState
	private readonly store: Promise<TelemetryStore["Service"]>
	private readonly handler: Promise<(request: Request) => Promise<Response>>
	/** Exports being read or stored now. Bounded by `maxPendingIngest`. */
	private pending = 0
	/** Exports refused since the collector started, by reason. */
	private readonly refused = { queueFull: 0, tooLarge: 0 }
	private lastRefusalLog = 0

	constructor(state: DurableObjectState) {
		this.state = state
		// The actor owns one connection and bootstrap. No native handle or detached fiber
		// escapes this scoped construction; durable alarms own subsequent maintenance.
		this.store = state.blockConcurrencyWhile(() =>
			Effect.runPromise(Effect.scoped(makeTelemetryStoreEffect(workerdDatabase(state.storage), { readonly: false, runRetention: false }))),
		)
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
	 * collector's memory for exports never exceeds `maxPendingIngest * maxIngestBytes`. A refused
	 * export is counted; OTLP exporters retry 429 after `Retry-After` and drop 413.
	 */
	private async ingest(request: Request): Promise<Response> {
		const declared = request.headers.get("content-length")
		if (declared !== null && Number(declared) > config.otel.maxIngestBytes) return this.refuse(request, "tooLarge")
		if (this.pending >= config.otel.maxPendingIngest) return this.refuse(request, "queueFull")
		this.pending += 1
		try {
			const signal = new URL(request.url).pathname === "/v1/traces" ? "traces" : "logs"
			const protobuf = /application\/(x-)?protobuf/i.test(request.headers.get("content-type") ?? "")
			let payload: unknown
			if (declared === null && protobuf) return Response.json({ error: "Protobuf exports need a Content-Length" }, { status: 411 })
			if (declared === null) {
				const body = await boundedText(request, config.otel.maxIngestBytes)
				if (body === undefined) return this.refuse(request, "tooLarge")
				payload = JSON.parse(body)
			} else if (protobuf) {
				const bytes = new Uint8Array(await request.arrayBuffer())
				payload = signal === "traces" ? decodeProtobufTraces(bytes) : decodeProtobufLogs(bytes)
			} else {
				// Parsed from the body without keeping its text: a whole export is a large string,
				// and one held while it is stored outlives the young generation.
				payload = await request.json()
			}
			return await this.store.then((store) => this.write(store, signal, payload))
		} catch {
			return Response.json({ error: "Invalid telemetry export" }, { status: 400 })
		} finally {
			this.pending -= 1
		}
	}

	/** Store one decoded export. Spans and logs are written before the response is sent. */
	private async write(store: TelemetryStore["Service"], signal: "traces" | "logs", payload: unknown): Promise<Response> {
		if ((await this.state.storage.getAlarm()) === null) {
			await this.state.storage.setAlarm(Date.now() + config.otel.retentionIntervalSeconds * 1000)
		}
		const stored: Effect.Effect<unknown, unknown> =
			signal === "traces"
				? Schema.decodeUnknownEffect(TraceExport)(payload).pipe(Effect.flatMap(store.ingestTraces))
				: Schema.decodeUnknownEffect(LogExport)(payload).pipe(Effect.flatMap(store.ingestLogs))
		const result = await Effect.runPromise(Effect.result(stored))
		return result._tag === "Success"
			? Response.json(result.success)
			: Response.json({ error: `Invalid or unstorable ${signal} export` }, { status: 400 })
	}

	private refuse(request: Request, reason: keyof MotelCollector["refused"]): Response {
		this.refused[reason] += 1
		// Discard the unread body; reading it is the work being refused.
		request.body?.cancel().catch(() => {})
		const now = Date.now()
		if (now - this.lastRefusalLog >= refusalLogInterval) {
			this.lastRefusalLog = now
			console.warn(JSON.stringify({ message: "motel: refused telemetry exports", ...this.ingestStatus() }))
		}
		return reason === "queueFull"
			? Response.json({ error: "Collector ingest queue is full" }, { status: 429, headers: { "retry-after": "1" } })
			: Response.json({ error: "Telemetry export exceeds the collector's size limit" }, { status: 413 })
	}

	private ingestStatus() {
		return {
			pending: this.pending,
			maxPending: config.otel.maxPendingIngest,
			maxBytes: config.otel.maxIngestBytes,
			refused: { ...this.refused },
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
