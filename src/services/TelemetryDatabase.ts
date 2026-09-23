/** Values accepted by both native SQLite and workerd SQLite. */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array
/** Prepared query operations used by the telemetry store. */
export interface TelemetryStatement {
	all(...values: SqlValue[]): unknown[]
	get(...values: SqlValue[]): unknown
	run(...values: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint }
}
/** SQLite ownership stays with the runtime adapter; the shared store owns its schema. */
export interface TelemetryDatabase {
	exec(sql: string): void
	query(sql: string): TelemetryStatement
	transaction<A extends unknown[], B>(run: (...args: A) => B): (...args: A) => B
	usedBytes(): number
	reclaim(): void
	checkpoint(mode: "RESTART" | "TRUNCATE"): void
	optimize(): void
}
