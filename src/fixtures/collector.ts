/** Real collector process with an OS-assigned port for transport integration tests. */
import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Logger } from "effect"
import { HttpServer } from "effect/unstable/http"
import { ServerLive } from "../localServer.ts"

BunRuntime.runMain(
	Effect.gen(function* () {
		const server = yield* HttpServer.HttpServer
		if (server.address._tag !== "TcpAddress") return yield* Effect.die("Expected TCP listener")
		yield* Console.log(JSON.stringify({ port: server.address.port }))
		yield* Effect.never
	}).pipe(Effect.provide(ServerLive), Effect.provide(Logger.layer([]))),
)
