import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * The embedded collector runs in the same workerd process as the product it observes, so its
 * memory and its store must stay within what the operator configured however long telemetry
 * keeps arriving. These tests run the built worker as a real workerd process with its inspector
 * open and measure the collector's isolate directly.
 */

const root = path.resolve(import.meta.dir, "..")
const mebibyte = 1024 * 1024

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

/** Bounds under test. Small enough that a short sustained load crosses every one of them. */
const bounds = {
	MOTEL_OTEL_MAX_SPANS: 1_500,
	MOTEL_OTEL_MAX_DB_SIZE_MB: 8,
	MOTEL_OTEL_MAX_PENDING_INGEST: 4,
	MOTEL_OTEL_MAX_INGEST_BYTES: mebibyte,
	MOTEL_OTEL_RETENTION_INTERVAL_SECONDS: 1,
} as const

const startCollector = async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "motel-bounds-"))
	const port = await freePort()
	const inspector = await freePort()
	await mkdir(path.join(directory, "data"))
	await copyFile(path.join(root, "dist/workerd/motel.mjs"), path.join(directory, "motel.mjs"))
	const bindings = Object.entries(bounds)
		.map(([name, value]) => `, (name = ${JSON.stringify(name)}, text = ${JSON.stringify(String(value))})`)
		.join("")
	const config = (await readFile(path.join(root, "workerd/motel.capnp"), "utf8"))
		.replace('embed "../dist/workerd/motel.mjs"', 'embed "motel.mjs"')
		.replace('path = "./web/dist"', `path = ${JSON.stringify(path.join(root, "web/dist"))}`)
		.replace('path = "./.local/workerd-data"', `path = ${JSON.stringify(path.join(directory, "data"))}`)
		.replace("127.0.0.1:27687", `127.0.0.1:${port}`)
		.replace('(name = "ASSETS", service = "assets")', `(name = "ASSETS", service = "assets")${bindings}`)
	await writeFile(path.join(directory, "config.capnp"), config)
	const log = path.join(directory, "server.log")
	const server = Bun.spawn(
		[
			path.join(root, "node_modules/.bin/workerd"),
			"serve",
			path.join(directory, "config.capnp"),
			"--experimental",
			`--inspector-addr=127.0.0.1:${inspector}`,
		],
		{ cwd: root, stdout: Bun.file(log), stderr: Bun.file(log) },
	)
	const origin = `http://127.0.0.1:${port}`
	for (let attempt = 0; ; attempt++) {
		if (server.exitCode !== null || attempt === 150) throw new Error(await readFile(log, "utf8"))
		if (await fetch(`${origin}/api/health`).then((response) => response.ok, () => false)) break
		await Bun.sleep(100)
	}
	// Graceful shutdown drains idle keep-alive connections; stored telemetry survives SIGKILL.
	const stop = async () => {
		server.kill(9)
		await server.exited
	}
	return { directory, origin, inspector: `127.0.0.1:${inspector}`, stop }
}

/** One DevTools session on the collector's isolate. */
const inspect = async (address: string) => {
	const targets = (await (await fetch(`http://${address}/json/list`)).json()) as Array<{ id: string; webSocketDebuggerUrl: string }>
	const target = targets.find((entry) => entry.id === "motel")
	if (target === undefined) throw new Error(`No collector isolate among ${targets.map((entry) => entry.id).join(", ")}`)
	const socket = new WebSocket(target.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${address}`))
	await new Promise((resolve, reject) => {
		socket.onopen = resolve
		socket.onerror = reject
	})
	let next = 0
	const pending = new Map<number, (value: unknown) => void>()
	socket.onmessage = (event) => {
		const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown }
		if (message.id !== undefined) pending.get(message.id)?.(message.result)
	}
	const send = <A>(method: string) =>
		new Promise<A>((resolve, reject) => {
			const id = ++next
			const timer = setTimeout(() => reject(new Error(`Inspector ${method} timed out`)), 20_000)
			pending.set(id, (value) => {
				clearTimeout(timer)
				resolve(value as A)
			})
			socket.send(JSON.stringify({ id, method, params: {} }))
		})
	type Usage = { readonly usedSize: number; readonly totalSize: number; readonly backingStorageSize: number }
	return {
		usage: () => send<Usage>("Runtime.getHeapUsage"),
		collect: () => send<unknown>("HeapProfiler.enable").then(() => send<unknown>("HeapProfiler.collectGarbage")),
		close: () => socket.close(),
	}
}

const hex = (length: number) => Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join("")
const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } })

/** A product-shaped export: traces of 40 database and HTTP spans with statement text. */
const traceExport = (spans: number) => {
	const now = BigInt(Date.now()) * 1_000_000n
	let traceId = hex(32)
	let rootId = hex(16)
	return {
		resourceSpans: [
			{
				resource: { attributes: [attribute("service.name", "synthetic-product"), attribute("service.version", "0.0.0")] },
				scopeSpans: [
					{
						scope: { name: "synthetic" },
						spans: Array.from({ length: spans }, (_, index) => {
							if (index % 40 === 0) {
								traceId = hex(32)
								rootId = hex(16)
							}
							return {
								traceId,
								spanId: index % 40 === 0 ? rootId : hex(16),
								...(index % 40 === 0 ? {} : { parentSpanId: rootId }),
								name: ["sql.execute", "storage.query", "http.server POST"][index % 3],
								kind: 1,
								startTimeUnixNano: String(now - 5_000_000n),
								endTimeUnixNano: String(now),
								attributes: [
									attribute("db.system.name", "postgresql"),
									attribute("db.query.text", `select "id", "name", "slug" from "records" where "owner" = $1 and "slug" = $2 limit ${index} -- ${hex(32)}`),
									attribute("synthetic.record.id", hex(40)),
								],
								status: { code: 1 },
							}
						}),
					},
				],
			},
		],
	}
}

const post = (origin: string, body: string, init: RequestInit = {}) =>
	fetch(`${origin}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body, ...init })

const storedTelemetry = async (directory: string) => {
	// workerd keeps each durable object's SQLite file under its namespace's unique key.
	const store = path.join(directory, "data", "motel")
	const files = (await readdir(store)).filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")
	expect(files).toHaveLength(1)
	const database = new Database(path.join(store, files[0]!), { readonly: true })
	try {
		const count = (sql: string) => (database.query(sql).get() as { value: number }).value
		return {
			spans: count("SELECT COUNT(*) AS value FROM spans"),
			bytes: count("SELECT (page_count - freelist_count) * page_size AS value FROM pragma_page_count(), pragma_freelist_count(), pragma_page_size()"),
		}
	} finally {
		database.close()
	}
}

test("workerd collector holds its configured memory and retention bounds under sustained ingest", async () => {
	const collector = await startCollector()
	const isolate = await inspect(collector.inspector)
	try {
		// Up to 400 spans a second: twelve times the span bound and several times the size bound.
		const requests = 180
		const perRequest = 100
		let peakExternal = 0
		let accepted = 0
		for (let tick = 0; tick < requests; tick++) {
			const at = Date.now()
			const response = await post(collector.origin, JSON.stringify(traceExport(perRequest)))
			expect(response.status).toBe(200)
			accepted += ((await response.json()) as { insertedSpans: number }).insertedSpans
			// Sampled without forcing a collection: what the process holds is what the kernel counts.
			if (tick % 4 === 0) peakExternal = Math.max(peakExternal, (await isolate.usage()).backingStorageSize)
			await Bun.sleep(Math.max(0, 250 - (Date.now() - at)))
		}
		expect(accepted).toBe(requests * perRequest)
		// Buffers the collector holds for requests are bounded by its ingest queue: at most the
		// configured number of pending requests, each at most the configured size, plus the
		// runtime's own few MiB. Anything above that is allocated per request and left behind.
		expect(peakExternal / mebibyte).toBeLessThanOrEqual(
			(bounds.MOTEL_OTEL_MAX_PENDING_INGEST * bounds.MOTEL_OTEL_MAX_INGEST_BYTES) / mebibyte + 8,
		)
		// No span is kept in memory once it is stored.
		await isolate.collect()
		expect((await isolate.usage()).usedSize / mebibyte).toBeLessThanOrEqual(32)
		// Two retention passes after the last export bring the store within every bound.
		await Bun.sleep(2_500)
	} finally {
		isolate.close()
		await collector.stop()
	}
	const stored = await storedTelemetry(collector.directory)
	expect(stored.spans).toBeGreaterThan(0)
	expect(stored.spans).toBeLessThanOrEqual(bounds.MOTEL_OTEL_MAX_SPANS)
	expect(stored.bytes).toBeLessThanOrEqual(bounds.MOTEL_OTEL_MAX_DB_SIZE_MB * mebibyte)
	await rm(collector.directory, { recursive: true, force: true })
}, 120_000)

test("workerd collector refuses ingest beyond its queue and size bounds and counts what it refused", async () => {
	const collector = await startCollector()
	const held: Array<ReadableStreamDefaultController<Uint8Array>> = []
	try {
		// Fill the queue with exports whose bodies are still arriving.
		const stalled = Array.from({ length: bounds.MOTEL_OTEL_MAX_PENDING_INGEST }, () =>
			post(collector.origin, "", {
				body: new ReadableStream<Uint8Array>({
					start: (controller) => {
						held.push(controller)
						controller.enqueue(new TextEncoder().encode('{"resourceSpans":['))
					},
				}),
			}),
		)
		// Awaited below once released; a failed assertion before that must not leave them unhandled.
		for (const response of stalled) response.catch(() => {})
		for (let attempt = 0; held.length < bounds.MOTEL_OTEL_MAX_PENDING_INGEST && attempt < 50; attempt++) await Bun.sleep(20)
		await Bun.sleep(250)
		const refused = await post(collector.origin, JSON.stringify(traceExport(10)))
		expect(refused.status).toBe(429)
		expect(refused.headers.get("retry-after")).toBe("1")
		const oversized = await post(collector.origin, JSON.stringify(traceExport(10)).padEnd(bounds.MOTEL_OTEL_MAX_INGEST_BYTES + 1, " "))
		expect(oversized.status).toBe(413)
		// Completing the stalled exports frees the queue.
		for (const controller of held) {
			controller.enqueue(new TextEncoder().encode("]}"))
			controller.close()
		}
		for (const response of await Promise.all(stalled)) expect(response.status).toBe(200)
		const accepted = await post(collector.origin, JSON.stringify(traceExport(10)))
		expect(accepted.status).toBe(200)
		expect(await (await fetch(`${collector.origin}/api/ingest`)).json()).toMatchObject({
			maxPending: bounds.MOTEL_OTEL_MAX_PENDING_INGEST,
			maxBytes: bounds.MOTEL_OTEL_MAX_INGEST_BYTES,
			pending: 0,
			refused: { queueFull: 1, tooLarge: 1 },
		})
	} finally {
		await collector.stop()
		await rm(collector.directory, { recursive: true, force: true })
	}
}, 60_000)
