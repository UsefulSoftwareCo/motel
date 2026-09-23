import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createServer } from "node:net"

const root = path.resolve(import.meta.dir, "..")
const freePort = () =>
	new Promise<number>((resolve, reject) => {
		const socket = createServer()
		socket.once("error", reject)
		socket.listen(0, "127.0.0.1", () => {
			const address = socket.address()
			if (address === null || typeof address === "string") return reject(new Error("No TCP address"))
			socket.close((error) => (error ? reject(error) : resolve(address.port)))
		})
	})

/** Exercise the built collector over HTTP, using a real workerd process and persistent disk. */
test("workerd ingests, searches, retains and recovers telemetry after process loss", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "motel-workerd-"))
	const port = await freePort()
	const origin = `http://127.0.0.1:${port}`
	await mkdir(path.join(directory, "data"))
	await copyFile(path.join(root, "dist/workerd/motel.mjs"), path.join(directory, "motel.mjs"))
	const base = await readFile(path.join(root, "workerd/motel.capnp"), "utf8")
	const config = base
		.replace('embed "../dist/workerd/motel.mjs"', 'embed "motel.mjs"')
		.replace('path = "./web/dist"', `path = ${JSON.stringify(path.join(root, "web/dist"))}`)
		.replace('path = "./.local/workerd-data"', `path = ${JSON.stringify(path.join(directory, "data"))}`)
		.replace("127.0.0.1:27687", `127.0.0.1:${port}`)
		.replace(
			'(name = "ASSETS", service = "assets")',
			'(name = "ASSETS", service = "assets"), (name = "MOTEL_OTEL_RETENTION_INTERVAL_SECONDS", text = "1")',
		)
	await writeFile(path.join(directory, "config.capnp"), config)
	const start = () =>
		Bun.spawn([path.join(root, "node_modules/.bin/workerd"), "serve", path.join(directory, "config.capnp"), "--experimental"], {
			cwd: root,
			stdout: Bun.file(path.join(directory, "server.log")),
			stderr: Bun.file(path.join(directory, "server.log")),
		})
	let server = start()
	const waitFor = async (predicate: () => Promise<boolean>) => {
		for (let i = 0; i < 150; i++) {
			if (server.exitCode !== null) throw new Error(await readFile(path.join(directory, "server.log"), "utf8"))
			if (await predicate().catch(() => false)) return
			await Bun.sleep(100)
		}
		throw new Error("Collector condition timed out\n" + (await readFile(path.join(directory, "server.log"), "utf8")))
	}
	const post = async (route: string, value: unknown) => {
		const response = await fetch(origin + route, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(value),
		})
		expect(response.status).toBe(200)
		return response.json()
	}
	const trace = "0123456789abcdef0123456789abcdef"
	const oldTrace = "fedcba9876543210fedcba9876543210"
	const span = "0123456789abcdef"
	const resource = { attributes: [{ key: "service.name", value: { stringValue: "workerd-test" } }] }
	const spans = (traceId: string, at: number) => ({
		resourceSpans: [
			{
				resource,
				scopeSpans: [
					{
						spans: [
							{
								traceId,
								spanId: span,
								name: "persisted operation",
								startTimeUnixNano: String(BigInt(at - 1) * 1000000n),
								endTimeUnixNano: String(BigInt(at) * 1000000n),
								attributes: [{ key: "runtime", value: { stringValue: "workerd" } }],
							},
						],
					},
				],
			},
		],
	})
	try {
		await waitFor(async () => (await fetch(origin + "/api/health")).ok)
		expect(await post("/v1/traces", spans(trace, Date.now()))).toEqual({ insertedSpans: 1 })
		expect(
			await post("/v1/logs", {
				resourceLogs: [
					{
						resource,
						scopeLogs: [
							{
								logRecords: [
									{
										timeUnixNano: String(BigInt(Date.now()) * 1000000n),
										severityText: "INFO",
										body: { stringValue: "durable log" },
										traceId: trace,
										spanId: span,
									},
								],
							},
						],
					},
				],
			}),
		).toEqual({ insertedLogs: 1 })
		expect(await (await fetch(origin + "/api/spans/search?attr.runtime=workerd")).json()).toMatchObject({
			data: [{ span: { spanId: span, operationName: "persisted operation" } }],
		})
		expect(await (await fetch(origin + "/api/logs/search?service=workerd-test&body=durable")).json()).toMatchObject({
			data: [{ body: "durable log" }],
		})
		const schema = await (await fetch(origin + "/openapi.json")).json()
		expect(schema).toHaveProperty("paths./v1/traces")
		const malformed = await fetch(origin + "/v1/traces", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":42}]}]}]}',
		})
		expect(malformed.ok).toBe(false)
		// Include a six-day trace to prove the seven-day query policy survives the port.
		const sixDays = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		await post("/v1/traces", spans(sixDays, Date.now() - 6 * 86400000))
		expect(await (await fetch(origin + "/api/traces?service=workerd-test&lookback=7d")).json()).toMatchObject({ meta: { returned: 2 } })
		await post("/v1/traces", spans(oldTrace, Date.now() - 8 * 86400000))
		await waitFor(async () => (await fetch(origin + "/api/traces/" + oldTrace)).status === 404)
		// Acknowledged writes must survive SIGKILL, not only graceful shutdown.
		server.kill(9)
		await server.exited
		server = start()
		await waitFor(async () => (await fetch(origin + "/api/health")).ok)
		expect(await (await fetch(origin + "/api/traces/" + trace)).json()).toMatchObject({
			data: { traceId: trace, rootOperationName: "persisted operation", spanCount: 1 },
		})
		expect(await (await fetch(origin + "/api/logs/search?service=workerd-test&body=durable")).json()).toMatchObject({
			data: [{ body: "durable log", traceId: trace }],
		})
	} finally {
		server.kill()
		await server.exited
		await rm(directory, { recursive: true, force: true })
	}
}, 30000)
