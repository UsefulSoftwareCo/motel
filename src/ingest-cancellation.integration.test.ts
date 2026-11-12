import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"

/** A cancelled writer must not stop the shared worker or another caller's writes. */
test("a cancelled ingest request preserves concurrent trace and log delivery", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "motel-cancel-"))
	const databasePath = path.join(directory, "telemetry.sqlite")
	const server = Bun.spawn([process.execPath, "src/fixtures/collector.ts"], {
		cwd: path.resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			MOTEL_OTEL_BASE_URL: "http://127.0.0.1:0",
			MOTEL_OTEL_HOST: "127.0.0.1",
			MOTEL_OTEL_DB_PATH: databasePath,
			XDG_STATE_HOME: directory,
		},
		stdout: "pipe",
		stderr: Bun.file(path.join(directory, "server.log")),
	})
	let database: Database | undefined
	let locked = false
	try {
		const reader = server.stdout.getReader()
		let output = ""
		while (!output.includes("\n")) {
			const chunk = await reader.read()
			if (chunk.done) throw new Error("Collector exited before readiness")
			output += new TextDecoder().decode(chunk.value)
		}
		reader.releaseLock()
		const { port } = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ port: Schema.Number })))(
			output.split("\n")[0],
		)
		const origin = `http://127.0.0.1:${port}`
		const payload = (id: number) => ({
			resourceSpans: [
				{
					scopeSpans: [
						{
							spans: [
								{
									traceId: "0123456789abcdef0123456789abcdef",
									spanId: id.toString(16).padStart(16, "0"),
									name: "concurrent-write",
									startTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
									endTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
								},
							],
						},
					],
				},
			],
		})
		const post = (body: unknown, signal?: AbortSignal) =>
			fetch(`${origin}/v1/traces`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal,
			})
		expect((await post(payload(1))).status).toBe(200)
		database = new Database(databasePath)
		database.exec("BEGIN IMMEDIATE")
		locked = true
		const controller = new AbortController()
		const cancelled = post(payload(2), controller.signal).catch(() => undefined)
		const peers = [post(payload(3)), post(payload(4))]
		// The real SQLite lock holds writes while the HTTP server accepts all callers.
		// It is released by this process, independently of the blocked worker thread.
		await Bun.sleep(200)
		controller.abort()
		await cancelled
		await Bun.sleep(100)
		database.exec("ROLLBACK")
		locked = false
		for (const response of await Promise.all(peers)) {
			expect(response.status).toBe(200)
			expect(await response.json()).toEqual({ insertedSpans: 1 })
		}
		expect((await post(payload(5))).status).toBe(200)
		const delivered = database
			.query<{ count: number }, []>(
				"SELECT count(*) as count FROM spans WHERE span_id IN ('0000000000000003', '0000000000000004', '0000000000000005')",
			)
			.get()
		expect(delivered?.count).toBe(3)
	} finally {
		if (locked) database?.exec("ROLLBACK")
		database?.close()
		server.kill()
		await server.exited
		await rm(directory, { recursive: true, force: true })
	}
}, 15_000)
