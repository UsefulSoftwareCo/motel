import type { DurableObjectStorage, SqlStorageValue } from "@cloudflare/workers-types"
import type { SqlValue, TelemetryDatabase } from "./TelemetryDatabase.js"

const binding = (value: SqlValue): SqlStorageValue => {
	if (typeof value === "bigint") {
		const number = Number(value)
		if (!Number.isSafeInteger(number)) throw new RangeError("SQLite integer exceeds JavaScript precision")
		return number
	}
	if (typeof value === "boolean") return Number(value)
	if (value instanceof Uint8Array) return Uint8Array.from(value).buffer
	return value
}

/** Adapt workerd's owned SQLite connection without opening a second writer. */
export const workerdDatabase = (storage: DurableObjectStorage): TelemetryDatabase => {
	const sql = storage.sql
	const integer = (query: string, column: string): number => {
		const value = sql.exec(query).toArray()[0]?.[column]
		if (typeof value !== "number") throw new Error(`Expected SQLite number: ${column}`)
		return value
	}
	return {
		exec: (query) => {
			sql.exec(query).toArray()
		},
		query: (query) => ({
			all: (...values) => sql.exec(query, ...values.map(binding)).toArray(),
			get: (...values) => sql.exec(query, ...values.map(binding)).toArray()[0] ?? null,
			run: (...values) => {
				sql.exec(query, ...values.map(binding)).toArray()
				return {
					changes: integer("SELECT changes() AS value", "value"),
					lastInsertRowid: integer("SELECT last_insert_rowid() AS value", "value"),
				}
			},
		}),
		transaction:
			(run) =>
			(...args) =>
				storage.transactionSync(() => run(...args)),
		// This native property subtracts freelist pages before multiplying by page size.
		usedBytes: () => sql.databaseSize,
		// workerd owns checkpointing, vacuuming and query planner maintenance.
		reclaim: () => {},
		checkpoint: () => {},
		optimize: () => {},
	}
}
