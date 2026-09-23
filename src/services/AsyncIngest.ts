import { Context, type Effect } from "effect"
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import type { WorkerError } from "effect/unstable/workers/WorkerError"
import type { IngestError } from "./ingestRpc.js"
/** OTLP ingest capability, supplied by a worker pool or an in-process store. */
export class AsyncIngest extends Context.Service<
	AsyncIngest,
	{
		readonly ingestTraces: (input: {
			readonly payload: unknown
		}) => Effect.Effect<{ readonly insertedSpans: number }, IngestError | RpcClientError | WorkerError>
		readonly ingestLogs: (input: {
			readonly payload: unknown
		}) => Effect.Effect<{ readonly insertedLogs: number }, IngestError | RpcClientError | WorkerError>
	}
>()("@motel/AsyncIngest") {}
