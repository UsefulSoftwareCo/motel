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

/** One durable SQLite owner for OTLP ingestion, queries and bounded alarm maintenance. */
export class MotelCollector {
	private readonly state: DurableObjectState
	private readonly store: Promise<TelemetryStore["Service"]>

	constructor(state: DurableObjectState) {
		this.state = state
		// The actor owns one connection and bootstrap. No native handle or detached fiber
		// escapes this scoped construction; durable alarms own subsequent maintenance.
		this.store = state.blockConcurrencyWhile(() =>
			Effect.runPromise(Effect.scoped(makeTelemetryStoreEffect(workerdDatabase(state.storage), { readonly: false, runRetention: false }))),
		)
	}

	/** Serve through the same typed HTTP routes as the native collector. */
	async fetch(request: Request): Promise<Response> {
		const store = await this.store
		if ((await this.state.storage.getAlarm()) === null) {
			await this.state.storage.setAlarm(Date.now() + config.otel.retentionIntervalSeconds * 1000)
		}
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
		const handler = HttpRouter.toWebHandler(
			motelApi({ health, docs: documents }).pipe(
				HttpRouter.provideRequest(ingest),
				HttpRouter.provideRequest(Layer.succeed(TelemetryStoreReadonly, store)),
				Layer.provide(HttpServer.layerServices),
			),
			{ disableLogger: true },
		)
		try {
			return await handler.handler(request)
		} finally {
			await handler.dispose()
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
