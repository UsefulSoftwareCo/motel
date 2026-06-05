import * as fs from "node:fs"
import { promises as fsp } from "node:fs"
import * as path from "node:path"
import { Effect } from "effect"
import { isAlive, isManagedDaemonProcess, listAliveEntries, motelStateDir, MOTEL_SERVICE_ID, processIdentity, removeRegistryEntry, type RegistryEntry } from "./registry.js"

const DEFAULT_REPO_ROOT = path.resolve(import.meta.dir, "..")
const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 27686
const START_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 10_000
const LOCK_TIMEOUT_MS = 10_000
const START_POLL_INTERVAL_MS = 25
const POLL_INTERVAL_MS = 150
/** Fast probe used inside the waitForHealthy poll loop — we call it
 *  every POLL_INTERVAL_MS, so a generous budget would stall the loop. */
const HEALTH_FAST_TIMEOUT_MS = 750
/** Patient probe used on critical paths: the first getStatus() call
 *  in ensure(), and the final pre-throw check after a spawned child
 *  dies. A real daemon with a busy SQLite writer (FTS backfill, big
 *  DB) can easily take 1-2s to answer /api/health — if we declare
 *  the port empty at 750ms we'll spawn a duplicate and collide with
 *  EADDRINUSE. 3s is long enough to tolerate a slow healthy daemon
 *  and short enough that a truly-down daemon is still detected
 *  before START_TIMEOUT_MS fires. */
const HEALTH_PATIENT_TIMEOUT_MS = 3_000
const INGEST_PROBE_TIMEOUT_MS = 3_000

type HealthShape = {
	readonly ok: boolean
	readonly service: string
	readonly databasePath: string
	readonly pid: number
	readonly url: string
	readonly workdir: string
	readonly startedAt: string
	readonly version: string
	readonly instanceId?: string
}

type LockShape = {
	readonly pid: number
	readonly createdAt: string
	readonly processIdentity?: string
}

type DaemonConfig = {
	readonly repoRoot: string
	readonly serverEntry: string
	readonly workdir: string
	readonly runtimeDir: string
	readonly databasePath: string
	readonly logPath: string
	readonly lockPath: string
	readonly host: string
	readonly port: number
	readonly baseUrl: string
}

export type DaemonStatus = {
	readonly running: boolean
	readonly managed: boolean
	readonly service: string | null
	readonly pid: number | null
	readonly url: string
	readonly databasePath: string
	readonly workdir: string | null
	readonly startedAt: string | null
	readonly version: string | null
	readonly sameWorkdir: boolean
	readonly reason: string | null
	readonly logPath: string
	readonly lockPath: string
	readonly registryPid: number | null
}

export type DaemonManager = {
	readonly applyEnv: Effect.Effect<void>
	readonly getStatus: Effect.Effect<DaemonStatus, DaemonError>
	readonly ensure: Effect.Effect<DaemonStatus, DaemonError>
	readonly stop: Effect.Effect<DaemonStatus, DaemonError>
}

type DaemonOptions = {
	readonly repoRoot?: string
	readonly workdir?: string
	readonly runtimeDir?: string
	readonly databasePath?: string
	readonly host?: string
	readonly port?: number
	readonly startTimeoutMs?: number
	readonly gracefulStopTimeoutMs?: number
	readonly forceStopTimeoutMs?: number
}

export class DaemonError extends Error {
	readonly _tag = "DaemonError"
	constructor(message: string) {
		super(message)
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const resolveConfig = (options: DaemonOptions = {}): DaemonConfig => {
	const envBaseUrl = new URL(process.env.MOTEL_OTEL_BASE_URL?.trim() || process.env.MOTEL_OTEL_QUERY_URL?.trim() || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`)
	const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT)
	const workdir = path.resolve(options.workdir ?? process.cwd())
	const runtimeDir = path.resolve(options.runtimeDir ?? motelStateDir())
	const databasePath = path.resolve(options.databasePath ?? process.env.MOTEL_OTEL_DB_PATH?.trim() ?? path.join(runtimeDir, "telemetry.sqlite"))
	const host = options.host ?? process.env.MOTEL_OTEL_HOST?.trim() ?? envBaseUrl.hostname
	const envPort = Number.parseInt(process.env.MOTEL_OTEL_PORT?.trim() || envBaseUrl.port, 10)
	const port = options.port ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_PORT)
	return {
		repoRoot,
		serverEntry: path.join(repoRoot, "src/server.ts"),
		workdir,
		runtimeDir,
		databasePath,
		logPath: path.join(runtimeDir, "daemon.log"),
		lockPath: path.join(runtimeDir, "daemon.lock"),
		host,
		port,
		baseUrl: `http://${host}:${port}`,
	}
}

const workdirMatches = (targetWorkdir: string, daemonWorkdir: string) => {
	const normalizedTarget = targetWorkdir.endsWith(path.sep) ? targetWorkdir : `${targetWorkdir}${path.sep}`
	const normalizedDaemon = daemonWorkdir.endsWith(path.sep) ? daemonWorkdir : `${daemonWorkdir}${path.sep}`
	return normalizedTarget === normalizedDaemon || normalizedTarget.startsWith(normalizedDaemon)
}

const pickByUrl = (entries: readonly RegistryEntry[], baseUrl: string, databasePath: string) => {
	return entries
		.filter((entry) => {
			return entry.url === baseUrl && (entry.databasePath === undefined || entry.databasePath === databasePath)
		})
		.sort((a, b) => Number(b.databasePath === databasePath) - Number(a.databasePath === databasePath))[0] ?? null
}

const expectedEnv = (config: DaemonConfig, instanceId?: string) => ({
	MOTEL_RUNTIME_DIR: config.runtimeDir,
	...(instanceId ? { MOTEL_DAEMON_INSTANCE_ID: instanceId } : {}),
	MOTEL_OTEL_BASE_URL: config.baseUrl,
	MOTEL_OTEL_QUERY_URL: config.baseUrl,
	MOTEL_OTEL_HOST: config.host,
	MOTEL_OTEL_PORT: String(config.port),
	MOTEL_OTEL_DB_PATH: config.databasePath,
	MOTEL_OTEL_EXPORTER_URL: `${config.baseUrl}/v1/traces`,
	MOTEL_OTEL_LOGS_EXPORTER_URL: `${config.baseUrl}/v1/logs`,
})

export const createDaemonManager = (options: DaemonOptions = {}): DaemonManager => {
	const config = resolveConfig(options)
	const startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS
	const gracefulStopTimeoutMs = options.gracefulStopTimeoutMs ?? STOP_TIMEOUT_MS
	const forceStopTimeoutMs = options.forceStopTimeoutMs ?? 2_000
	const mapError = (error: unknown) => new DaemonError(error instanceof Error ? error.message : String(error))
	const readRegistryEntry = () => pickByUrl(listAliveEntries(config.runtimeDir), config.baseUrl, config.databasePath)

	const fetchHealth = async (timeoutMs: number = HEALTH_FAST_TIMEOUT_MS): Promise<HealthShape | null> => {
		try {
			const response = await fetch(`${config.baseUrl}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
			if (!response.ok) return null
			const health = await response.json() as HealthShape
			return health.ok ? health : null
		} catch {
			return null
		}
	}

	const fetchIngestProbe = async () => {
		try {
			const postEmpty = (path: string) => fetch(`${config.baseUrl}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
				signal: AbortSignal.timeout(INGEST_PROBE_TIMEOUT_MS),
			})
			const [traces, logs] = await Promise.all([postEmpty("/v1/traces"), postEmpty("/v1/logs")])
			return traces.ok && logs.ok
		} catch {
			return false
		}
	}

	const describeManagedMismatch = (health: HealthShape) => {
		if (health.service !== MOTEL_SERVICE_ID) {
			return `Port ${config.port} is in use by ${health.service}, not ${MOTEL_SERVICE_ID}.`
		}
		if (health.databasePath !== config.databasePath) {
			return `Port ${config.port} is serving motel with ${health.databasePath}, expected ${config.databasePath}.`
		}
		return null
	}

	const readLock = async (): Promise<LockShape | null> => {
		try {
			const raw = await fsp.readFile(config.lockPath, "utf8")
			return JSON.parse(raw) as LockShape
		} catch {
			return null
		}
	}

	const removeStaleLock = async () => {
		const current = await readLock()
		if (!current) {
			await fsp.rm(config.lockPath, { force: true })
			return true
		}
		if (current.processIdentity ? processIdentity(current.pid) === current.processIdentity : isAlive(current.pid)) return false
		await fsp.rm(config.lockPath, { force: true })
		return true
	}

	const acquireStartupLock = async () => {
		const deadline = Date.now() + LOCK_TIMEOUT_MS
		await fsp.mkdir(config.runtimeDir, { recursive: true })

		while (Date.now() < deadline) {
			try {
				const handle = await fsp.open(config.lockPath, "wx")
				const contents = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), processIdentity: processIdentity(process.pid) ?? undefined } satisfies LockShape)
				await handle.writeFile(contents, "utf8")
				return {
					release: async () => {
						await handle.close().catch(() => undefined)
						await fsp.rm(config.lockPath, { force: true }).catch(() => undefined)
					},
				}
			} catch (error) {
				const errno = error as NodeJS.ErrnoException
				if (errno.code !== "EEXIST") throw error
				if (await removeStaleLock()) continue
				await sleep(POLL_INTERVAL_MS)
			}
		}

		throw new Error(`Timed out waiting for daemon startup lock at ${config.lockPath}`)
	}

	const openLogFile = async () => {
		await fsp.mkdir(config.runtimeDir, { recursive: true })
		return fs.openSync(config.logPath, "a")
	}

	const waitForHealthy = async (pid: number, instanceId: string) => {
		const deadline = Date.now() + startTimeoutMs
		while (Date.now() < deadline) {
			const health = await fetchHealth()
			if (health) {
				const mismatch = describeManagedMismatch(health)
				const registry = readRegistryEntry()
				if (!mismatch && health.pid === pid && health.instanceId === instanceId && registry?.pid === pid && registry.instanceId === instanceId && isManagedDaemonProcess(registry) && await fetchIngestProbe()) return health
				if (mismatch) throw new Error(mismatch)
			}
			if (!isAlive(pid)) {
				throw new Error(`Daemon process ${pid} exited before becoming healthy. See ${config.logPath}.`)
			}
			await sleep(START_POLL_INTERVAL_MS)
		}
		throw new Error(`Timed out waiting for daemon health at ${config.baseUrl}/api/health. See ${config.logPath}.`)
	}

	const waitUntilNotOwned = async (entry: RegistryEntry, timeoutMs: number) => {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			if (!isManagedDaemonProcess(entry)) return true
			await sleep(POLL_INTERVAL_MS)
		}
		return !isManagedDaemonProcess(entry)
	}

	const stopPid = async (entry: RegistryEntry) => {
		if (!isManagedDaemonProcess(entry)) {
			throw new Error(`Refusing to stop pid ${entry.pid}: registry identity does not match the running managed daemon.`)
		}
		try {
			process.kill(entry.pid, "SIGTERM")
		} catch (error) {
			const errno = error as NodeJS.ErrnoException
			if (errno.code !== "ESRCH") throw error
		}

		if (!await waitUntilNotOwned(entry, gracefulStopTimeoutMs)) {
			try {
				process.kill(entry.pid, "SIGKILL")
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
			}
			if (!await waitUntilNotOwned(entry, forceStopTimeoutMs)) {
				throw new Error(`Timed out force-killing daemon ${entry.pid}.`)
			}
		}
		const current = readRegistryEntry()
		if (current?.pid === entry.pid && current.instanceId === entry.instanceId) removeRegistryEntry(entry.pid, config.runtimeDir)
	}

	const getStatus = async (timeoutMs: number = HEALTH_FAST_TIMEOUT_MS): Promise<DaemonStatus> => {
		const registry = readRegistryEntry()
		const health = await fetchHealth(timeoutMs)
		if (!health) {
			return {
				running: false,
				managed: false,
				service: null,
				pid: registry?.pid ?? null,
				url: config.baseUrl,
				databasePath: config.databasePath,
				workdir: registry?.workdir ?? null,
				startedAt: registry?.startedAt ?? null,
				version: registry?.version ?? null,
				sameWorkdir: registry ? workdirMatches(config.workdir, registry.workdir) : false,
				reason: registry ? "Registry entry exists but daemon is not healthy." : null,
				logPath: config.logPath,
				lockPath: config.lockPath,
				registryPid: registry?.pid ?? null,
			}
		}

		const mismatch = describeManagedMismatch(health)
		const managed = mismatch === null && registry?.pid === health.pid && registry.instanceId === health.instanceId && isManagedDaemonProcess(registry)
		return {
			running: mismatch === null,
			managed,
			service: health.service,
			pid: health.pid,
			url: health.url,
			databasePath: health.databasePath,
			workdir: health.workdir,
			startedAt: health.startedAt,
			version: health.version,
			sameWorkdir: workdirMatches(config.workdir, health.workdir),
			reason: mismatch ?? (managed ? null : "Responsive motel server is not an identity-verified managed daemon."),
			logPath: config.logPath,
			lockPath: config.lockPath,
			registryPid: registry?.pid ?? null,
		}
	}

	const ensure = async (): Promise<DaemonStatus> => {
		// Use the patient timeout for the initial probe — this is the
		// critical "is there already a daemon here?" check. A false
		// negative here drops us into the spawn path and collides with
		// any slow-but-healthy daemon sitting on the port.
		const existing = await getStatus(HEALTH_PATIENT_TIMEOUT_MS)
		const existingEntry = readRegistryEntry()
		if (existing.managed && existing.running) {
			// /api/health can stay healthy after the lazy ingest worker/RPC path
			// has been poisoned by an interrupted request. Empty OTLP posts are
			// side-effect free and exercise the same path real exporters need.
			if (existing.pid === process.pid || await fetchIngestProbe()) return existing
			if (existingEntry) await stopPid(existingEntry)
		}
		if (!existing.running && existingEntry && isManagedDaemonProcess(existingEntry)) await stopPid(existingEntry)
		if (existing.service !== null && existing.reason) {
			throw new Error(existing.reason)
		}

		const lock = await acquireStartupLock()
		let spawnedPid: number | null = null
		let spawnedIdentity: string | null = null
		try {
			// Same reasoning for the post-lock re-check: another ensure()
			// may have spawned a daemon between our first probe and the
			// lock grant, and its initial health response can be slow
			// while the runtime warms up.
			const rechecked = await getStatus(HEALTH_PATIENT_TIMEOUT_MS)
			if (rechecked.managed && rechecked.running) {
				if (rechecked.pid === process.pid || await fetchIngestProbe()) return rechecked
				const recheckedEntry = readRegistryEntry()
				if (recheckedEntry) await stopPid(recheckedEntry)
			}
			if (rechecked.service !== null && rechecked.reason) {
				throw new Error(rechecked.reason)
			}

			const logFd = await openLogFile()
			const instanceId = crypto.randomUUID()
			try {
				const proc = Bun.spawn({
					cmd: [process.execPath, "run", config.serverEntry],
					cwd: config.workdir,
					detached: true,
					env: {
						...process.env,
						...expectedEnv(config, instanceId),
					},
					stdio: ["ignore", logFd, logFd],
				})
				spawnedPid = proc.pid
				spawnedIdentity = processIdentity(proc.pid)
				proc.unref()
			} finally {
				fs.closeSync(logFd)
			}

			if (spawnedPid === null) {
				throw new Error("Daemon failed to spawn.")
			}

			const health = await waitForHealthy(spawnedPid, instanceId)
			return {
				running: true,
				managed: true,
				service: health.service,
				pid: health.pid,
				url: health.url,
				databasePath: health.databasePath,
				workdir: health.workdir,
				startedAt: health.startedAt,
				version: health.version,
				sameWorkdir: workdirMatches(config.workdir, health.workdir),
				reason: null,
				logPath: config.logPath,
				lockPath: config.lockPath,
				registryPid: health.pid,
			}
		} catch (error) {
			if (spawnedPid !== null) {
				const entry = readRegistryEntry()
				if (entry?.pid === spawnedPid) {
					await stopPid(entry).catch(() => undefined)
				} else if (spawnedIdentity && processIdentity(spawnedPid) === spawnedIdentity) {
					try { process.kill(spawnedPid, "SIGTERM") } catch { /* already exited */ }
					const deadline = Date.now() + gracefulStopTimeoutMs
					while (Date.now() < deadline && processIdentity(spawnedPid) === spawnedIdentity) await sleep(POLL_INTERVAL_MS)
					if (processIdentity(spawnedPid) === spawnedIdentity) {
						try { process.kill(spawnedPid, "SIGKILL") } catch { /* already exited */ }
					}
				}
			}
			throw error
		} finally {
			await lock.release()
		}
	}

	const stop = async (): Promise<DaemonStatus> => {
		const status = await getStatus()
		if (status.pid === null) return status
		if (status.service !== null && status.service !== MOTEL_SERVICE_ID) {
			throw new Error(`Refusing to stop non-motel service ${status.service} on ${status.url}.`)
		}
		const entry = readRegistryEntry()
		if (!entry || entry.pid !== status.pid) throw new Error(`Refusing to stop pid ${status.pid}: no matching managed registry entry.`)
		await stopPid(entry)
		return await getStatus()
	}

	return {
		applyEnv: Effect.sync(() => {
			for (const [key, value] of Object.entries(expectedEnv(config))) {
				process.env[key] = value
			}
		}),
		getStatus: Effect.fn("DaemonManager.getStatus")(() =>
			Effect.tryPromise({
				// Wrapped so Effect.tryPromise only sees the no-arg call
				// signature — the optional timeoutMs parameter is an
				// internal detail used by ensure()'s critical probes.
				try: () => getStatus(),
				catch: mapError,
			}),
		)(),
		ensure: Effect.fn("DaemonManager.ensure")(() =>
			Effect.tryPromise({
				try: ensure,
				catch: mapError,
			}),
		)(),
		stop: Effect.fn("DaemonManager.stop")(() =>
			Effect.tryPromise({
				try: stop,
				catch: mapError,
			}),
		)(),
	}
}

export const applyManagedDaemonEnv = Effect.suspend(() => createDaemonManager().applyEnv)
export const getManagedDaemonStatus = Effect.suspend(() => createDaemonManager().getStatus)
export const ensureManagedDaemon = Effect.suspend(() => createDaemonManager().ensure)
export const stopManagedDaemon = Effect.suspend(() => createDaemonManager().stop)
