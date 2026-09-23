import { Database } from "bun:sqlite"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { dirname } from "node:path"
import { Effect, FileSystem, Layer, Schedule } from "effect"
import { config } from "../config.js"
import { makeTelemetryStoreEffect, TelemetryStore, TelemetryStoreReadonly, type TelemetryStoreOptions } from "./TelemetryStore.js"
const makeBunTelemetryStore = (opts: TelemetryStoreOptions) =>
	Effect.gen(function* () {
		const fileSystem = yield* FileSystem.FileSystem
		yield* fileSystem.makeDirectory(dirname(config.otel.databasePath), { recursive: true })
		const db = yield* Effect.acquireRelease(
			Effect.sync(
				() =>
					new Database(config.otel.databasePath, {
						create: !opts.readonly,
						readonly: opts.readonly,
					}),
			),
			(db) =>
				Effect.sync(() => {
					if (!opts.readonly) {
						// `PRAGMA optimize` at close persists any stats SQLite gathered
						// during the session, so the next process start gets an accurate
						// query planner on the first query instead of a 3-second cold
						// run. Cheap: it skips work unless stats have drifted.
						try {
							db.exec(`PRAGMA optimize;`)
						} catch {
							/* nothing */
						}
					}
					db.close()
				}),
		)
		db.exec(
			opts.readonly
				? `PRAGMA query_only = 1; PRAGMA busy_timeout = 15000; PRAGMA cache_size = -65536; PRAGMA mmap_size = 268435456;`
				: `PRAGMA busy_timeout = 15000; PRAGMA cache_size = -65536; PRAGMA mmap_size = 268435456; PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA wal_autocheckpoint = 4000; PRAGMA journal_size_limit = 134217728;`,
		)
		const pragmaNumber = (name: string) => {
			const row: unknown = db.query(`PRAGMA ${name}`).get()
			if (typeof row !== "object" || row === null || !(name in row)) throw new Error(`Missing SQLite pragma: ${name}`)
			const value = Reflect.get(row, name)
			if (typeof value !== "number") throw new Error(`Invalid SQLite pragma: ${name}`)
			return value
		}
		const bestEffort = (sql: string) => {
			try {
				db.exec(sql)
			} catch {
				/* Native maintenance may be busy. */
			}
		}
		return yield* makeTelemetryStoreEffect(
			{
				exec: (sql) => {
					db.exec(sql)
				},
				query: (sql) => db.query(sql),
				transaction: (run) => db.transaction(run),
				usedBytes: () => (pragmaNumber("page_count") - pragmaNumber("freelist_count")) * pragmaNumber("page_size"),
				reclaim: () => {
					const pageCount = pragmaNumber("page_count")
					if (pageCount === 0) return
					const ratio = pragmaNumber("freelist_count") / pageCount
					if (ratio < 0.05) return
					const pages = ratio >= 0.5 ? 50000 : ratio >= 0.2 ? 20000 : 2000
					bestEffort(`PRAGMA incremental_vacuum(${pages})`)
					bestEffort(`PRAGMA wal_checkpoint(${ratio >= 0.5 ? "TRUNCATE" : "RESTART"})`)
				},
				checkpoint: (mode) => bestEffort(`PRAGMA wal_checkpoint(${mode})`),
				optimize: () => bestEffort("PRAGMA analysis_limit = 1000; PRAGMA optimize;"),
			},
			opts,
		)
	})
/** Compatibility factory for callers constructing a writer/query-capable store layer. */
export const makeTelemetryStoreLayer = (opts: TelemetryStoreOptions) =>
	Layer.effect(TelemetryStore, makeBunTelemetryStore(opts)).pipe(Layer.provide(BunFileSystem.layer))

/**
 * Default writer runtime used by tests and direct store consumers.
 */
export const TelemetryStoreLive = makeTelemetryStoreLayer({ readonly: false, runRetention: true })

/**
 * The ingest worker's writer. It is the managed daemon's sole owner of
 * schema migrations, FTS backfill, retention, and page reclamation.
 */
export const TelemetryStoreWorkerLive = TelemetryStoreLive

/**
 * Read-only instance for query-only processes (currently the TUI and
 * HTTP query handlers). Skips every DDL/DML statement at startup so
 * the connection can be opened while a writer is mid-transaction
 * without racing for the write lock. Provided as TelemetryStoreReadonly
 * — a distinct service identifier so it can coexist with the writer
 * TelemetryStore in the same runtime.
 */
export const TelemetryStoreReadonlyLive = Layer.effect(
	TelemetryStoreReadonly,
	makeBunTelemetryStore({ readonly: true, runRetention: false }),
).pipe(Layer.provide(BunFileSystem.layer))

/** Query-worker reader that waits for the sole writer to finish schema bootstrap. */
export const TelemetryStoreQueryWorkerLive = Layer.effect(
	TelemetryStoreReadonly,
	makeBunTelemetryStore({ readonly: true, runRetention: false }).pipe(
		Effect.map((store) => TelemetryStoreReadonly.of(store)),
		Effect.retry(Schedule.spaced("50 millis")),
	),
).pipe(Layer.provide(BunFileSystem.layer))
