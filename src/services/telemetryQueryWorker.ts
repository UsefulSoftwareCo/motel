import { BunRuntime } from "@effect/platform-bun"
import * as BunWorkerRunner from "@effect/platform-bun/BunWorkerRunner"
import { Effect, Layer } from "effect"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import { TelemetryStoreQueryWorkerLive, TelemetryStoreReadonly, type TelemetryStoreReader } from "./TelemetryStore.js"
import { QueryError, QueryRpcs } from "./queryRpc.js"

type QueryMethod = keyof TelemetryStoreReader

const QueryHandlers = QueryRpcs.toLayer(Effect.gen(function*() {
	const store = yield* TelemetryStoreReadonly
	return {
		query: ({ method, args }) => {
			const member = Reflect.get(store, method as QueryMethod) as unknown
			const result = typeof member === "function" ? Reflect.apply(member, store, args) : member
			return (result as Effect.Effect<unknown, Error>).pipe(
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
