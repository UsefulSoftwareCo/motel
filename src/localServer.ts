import path from "node:path"
import { Effect, FileSystem, Layer } from "effect"
import { config } from "./config.js"
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpStaticServer from "effect/unstable/http/HttpStaticServer"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { MOTEL_SERVICE_ID, MOTEL_VERSION, processIdentity, removeRegistryEntry, writeRegistryEntry } from "./registry.js"
import { AsyncIngestLive } from "./services/AsyncIngestBun.js"
import { TelemetryQueryLive } from "./services/TelemetryQuery.js"
import { motelApi } from "./httpServer.js"
let serverStartedAt = new Date().toISOString()
const healthPayload = () => ({
	ok: true,
	service: MOTEL_SERVICE_ID,
	databasePath: config.otel.databasePath,
	pid: process.pid,
	url: config.otel.baseUrl,
	workdir: process.cwd(),
	startedAt: serverStartedAt,
	version: MOTEL_VERSION,
	instanceId: process.env.MOTEL_DAEMON_INSTANCE_ID?.trim(),
})
const ApiLayer = Layer.unwrap(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const debug = yield* fs.readFileString(path.resolve(import.meta.dir, "../skills/motel-debug/SKILL.md"))
		const effect = yield* fs.readFileString(path.resolve(import.meta.dir, "../skills/motel-debug/references/effect.md"))
		return motelApi({ health: healthPayload, docs: { debug, effect } })
	}),
)
// Web UI: Vite-built SPA served from web/dist. HttpStaticServer.layer
// handles GET /*, filesystem lookup under `root`, and SPA fallback to
// index.html for unknown paths — replacing the hand-rolled serveWebUi
// wrapper that previously lived inline with Bun.serve. The API routes
// above take precedence because HttpApi registers specific paths that
// the router matches before falling through to the /* catch-all.
const WEB_DIST_DIR = path.resolve(import.meta.dir, "../web/dist")
const StaticLayer = HttpStaticServer.layer({
	root: WEB_DIST_DIR,
	spa: true,
})

// Registry-entry writer as a scoped acquisition. The entry is published
// after BunHttpServer.layer binds the socket (scope acquisition order)
// and removed on scope release, so a bind failure never leaves a zombie
// entry and a graceful shutdown cleans up alongside the server stop —
// both in the same finalizer chain managed by Layer.launch.
const RegistryLayer = Layer.effectDiscard(
	Effect.acquireRelease(
		Effect.sync(() => {
			serverStartedAt = new Date().toISOString()
			try {
				writeRegistryEntry({
					pid: process.pid,
					url: config.otel.baseUrl,
					workdir: process.cwd(),
					startedAt: serverStartedAt,
					version: MOTEL_VERSION,
					databasePath: config.otel.databasePath,
					instanceId: process.env.MOTEL_DAEMON_INSTANCE_ID?.trim(),
					processIdentity: processIdentity(process.pid) ?? undefined,
				})
			} catch (err) {
				console.warn(`motel: failed to write registry entry: ${(err as Error).message}`)
			}
		}),
		() => Effect.sync(() => removeRegistryEntry(process.pid)),
	),
)

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/**
 * Launchable server layer. Composes the API + static UI + store + registry,
 * wraps the whole stack in HttpMiddleware.tracer (per-request OTel spans
 * with http.method / url / status / user-agent attributes), and binds the
 * socket via @effect/platform-bun's BunHttpServer. Use from server.ts:
 *
 *   await Effect.runPromise(Layer.launch(ServerLive))
 *
 * Socket lifecycle, graceful shutdown, and error propagation are managed
 * by the BunHttpServer layer's Scope — no hand-rolled start/stop plumbing.
 * `reusePort: true` is retained as defense-in-depth against TIME_WAIT
 * rebind conflicts (the registry-based adoption path in daemon.ts is the
 * primary protection, but this covers a raw `bun src/server.ts` restart).
 */
export const ServerLive = HttpRouter.serve(Layer.mergeAll(ApiLayer, StaticLayer, RegistryLayer), {
	middleware: HttpMiddleware.tracer,
}).pipe(
	// OTLP ingest paths are NOT traced by the middleware, otherwise
	// MOTEL_OTEL_ENABLED creates a feedback loop: every outbound span
	// POSTs to /v1/traces, the tracer emits a span for that POST, which
	// POSTs again on the next flush. This also shaves ~1 KB of header
	// attributes off every ingest request that would have been written
	// to the spans table as noise.
	Layer.provide(HttpMiddleware.layerTracerDisabledForUrls(["/api/health", "/v1/traces", "/v1/logs"])),
	// The telemetry worker owns ingest, migrations, and bounded maintenance.
	// The HTTP thread only opens an existing database read-only (or bootstraps
	// a brand-new empty one), keeping health independent of writer work.
	Layer.provideMerge(AsyncIngestLive),
	Layer.provideMerge(TelemetryQueryLive),
	Layer.provideMerge(
		BunHttpServer.layer({
			port: config.otel.port,
			hostname: config.otel.host,
			reusePort: true,
			routes: {
				"/api/health": () => Response.json(healthPayload()),
			},
		}),
	),
)
