import { BunRuntime } from "@effect/platform-bun"
import * as BunWorkerRunner from "@effect/platform-bun/BunWorkerRunner"
import { Effect, Layer } from "effect"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import { TelemetryStoreQueryWorkerLive, TelemetryStoreReadonly, type TelemetryStoreReader } from "./TelemetryStore.js"
import { QueryError, QueryRpcs } from "./queryRpc.js"

type QueryMethod = keyof TelemetryStoreReader

// The query RPC's success channel is Schema.Unknown, whose wire guard
// (SchemaAST isJson) rejects any object graph that visits the same object
// twice. getTrace/getSpan results share span/event objects across the
// tree, so every detail endpoint failed with "Expected JSON value". Deep-
// copy to break the sharing; keep Date instances intact — msgpackr carries
// them natively and the HTTP layer's pagination (httpListPolicy) calls
// .getTime() on summaries' startedAt.
const unshare = (value: unknown): unknown => {
	if (value === null || typeof value !== "object") return value
	if (value instanceof Date) return new Date(value.getTime())
	if (Array.isArray(value)) return value.map(unshare)
	const out: Record<string, unknown> = {}
	for (const [key, entry] of Object.entries(value)) out[key] = unshare(entry)
	return out
}

const QueryHandlers = QueryRpcs.toLayer(Effect.gen(function*() {
	const store = yield* TelemetryStoreReadonly
	return {
		query: ({ method, args }) => {
			const member = Reflect.get(store, method as QueryMethod) as unknown
			const result = typeof member === "function" ? Reflect.apply(member, store, args) : member
			return (result as Effect.Effect<unknown, Error>).pipe(
				Effect.map(unshare),
				Effect.mapError((error) => new QueryError({ message: String(error) })),
			)
		},
	}
}))

const WorkerLive = RpcServer.layer(QueryRpcs).pipe(
	Layer.provide(QueryHandlers),
	Layer.provide(TelemetryStoreQueryWorkerLive),
	Layer.provide(RpcServer.layerProtocolWorkerRunner),
	Layer.provide(RpcSerialization.layerMsgPack),
	Layer.provide(BunWorkerRunner.layer),
)

Layer.launch(WorkerLive).pipe(BunRuntime.runMain)
