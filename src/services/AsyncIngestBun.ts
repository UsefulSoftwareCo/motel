import * as BunWorker from "@effect/platform-bun/BunWorker"
import { Duration, Effect, Exit, Layer, Scope } from "effect"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import { WorkerError } from "effect/unstable/workers/WorkerError"
import { IngestRpcs } from "./ingestRpc.ts"

import { AsyncIngest } from "./AsyncIngest.js"
// Protocol: RpcClient.layerProtocolWorker manages a worker pool and
// speaks msgpack over structured-clone messages. `size: 1` matches
// SQLite's single-writer constraint.
const WorkerProtocol = RpcClient.layerProtocolWorker({ size: 1 }).pipe(
	Layer.provide(RpcSerialization.layerMsgPack),
	Layer.provide(BunWorker.layer(() => new Worker(new URL("./telemetryWorker.ts", import.meta.url)))),
)

export const AsyncIngestLive = Layer.effect(
	AsyncIngest,
	Effect.gen(function* () {
		const scope = yield* Scope.Scope
		// Keep daemon startup cheap: creating the RPC client here would eagerly
		// spawn the worker and make /api/health wait on the worker's SQLite
		// bootstrap. Cache a lazy initializer instead so the worker only starts
		// on the first ingest request, but is still shared thereafter.
		const [getClient, invalidateClient] = yield* Effect.cachedInvalidateWithTTL(
			Effect.gen(function* () {
				const clientScope = yield* Scope.fork(scope, "sequential")
				const protocolContext = yield* Layer.buildWithScope(WorkerProtocol, clientScope)
				const client = yield* RpcClient.make(IngestRpcs).pipe(
					Effect.provide(protocolContext),
					Effect.provideService(Scope.Scope, clientScope),
				)
				return { client, clientScope }
			}),
			Duration.infinity,
		)
		// Start the sole writer/maintenance worker immediately, but do not make
		// HTTP health wait for SQLite bootstrap. Managed readiness still verifies
		// the worker through explicit ingest probes.
		yield* Effect.forkScoped(getClient.pipe(Effect.ignore))
		// Cancellation and payload errors belong to one request. Only a broken
		// transport invalidates the worker shared by all ingest callers.
		return {
			ingestTraces: (input) =>
				Effect.flatMap(getClient, ({ client, clientScope }) =>
					client
						.ingestTraces(input)
						.pipe(
							Effect.tapError((error) =>
								error instanceof RpcClientError || error instanceof WorkerError
									? Effect.andThen(Scope.close(clientScope, Exit.void), invalidateClient)
									: Effect.void,
							),
						),
				),
			ingestLogs: (input) =>
				Effect.flatMap(getClient, ({ client, clientScope }) =>
					client
						.ingestLogs(input)
						.pipe(
							Effect.tapError((error) =>
								error instanceof RpcClientError || error instanceof WorkerError
									? Effect.andThen(Scope.close(clientScope, Exit.void), invalidateClient)
									: Effect.void,
							),
						),
				),
		}
	}),
)
