import { Effect, Layer, Context } from "effect"
import type { LogItem } from "../domain.js"
import { TelemetryStore } from "./TelemetryStore.js"

/**
 * Compatibility adapter for consumers importing the historical log query module.
 * New internal callers should use TelemetryStoreReadonly directly.
 */
export class LogQueryService extends Context.Service<
	LogQueryService,
	{
		readonly listRecentLogs: (serviceName: string) => Effect.Effect<readonly LogItem[], Error>
		readonly listTraceLogs: (traceId: string) => Effect.Effect<readonly LogItem[], Error>
		readonly searchLogs: (input: { readonly serviceName?: string | null; readonly severity?: string | null; readonly traceId?: string | null; readonly spanId?: string | null; readonly body?: string | null; readonly lookbackMinutes?: number; readonly limit?: number; readonly cursorTimestampMs?: number; readonly cursorId?: string; readonly attributeFilters?: Readonly<Record<string, string>>; readonly attributeContainsFilters?: Readonly<Record<string, string>> }) => Effect.Effect<readonly LogItem[], Error>
		readonly logStats: (input: { readonly groupBy: string; readonly agg: "count"; readonly serviceName?: string | null; readonly traceId?: string | null; readonly spanId?: string | null; readonly body?: string | null; readonly lookbackMinutes?: number; readonly limit?: number; readonly attributeFilters?: Readonly<Record<string, string>>; readonly attributeContainsFilters?: Readonly<Record<string, string>> }) => Effect.Effect<readonly { readonly group: string; readonly value: number; readonly count: number }[], Error>
		readonly listFacets: (input: { readonly type: "traces" | "logs"; readonly field: string; readonly serviceName?: string | null; readonly lookbackMinutes?: number; readonly limit?: number }) => Effect.Effect<readonly { readonly value: string; readonly count: number }[], Error>
	}
>()("motel/LogQueryService") {}

export const LogQueryServiceLive = Layer.effect(
	LogQueryService,
	Effect.map(TelemetryStore, (store) => LogQueryService.of({
		listRecentLogs: store.listRecentLogs,
		listTraceLogs: store.listTraceLogs,
		searchLogs: store.searchLogs,
		logStats: store.logStats,
		listFacets: store.listFacets,
	})),
)
