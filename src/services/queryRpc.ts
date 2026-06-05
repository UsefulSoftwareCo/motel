import { Schema } from "effect"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"

export class QueryError extends Schema.TaggedErrorClass<QueryError>()("QueryError", {
	message: Schema.String,
}) {}

export const QueryRpcs = RpcGroup.make(
	Rpc.make("query", {
		payload: { method: Schema.String, args: Schema.Array(Schema.Unknown) },
		success: Schema.Unknown,
		error: QueryError,
	}),
)
