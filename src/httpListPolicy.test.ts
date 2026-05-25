import { describe, expect, it } from "bun:test"
import type { LogItem, TraceSummaryItem } from "./domain.js"
import { LOG_LIST, LOG_STATS, parseListParams, paginateLogs, paginateSummaries, traceCursorArgs } from "./httpListPolicy.js"

const BASE_URL = "http://127.0.0.1:27686"

describe("HTTP list policy", () => {
	it("bounds list parameters and extracts attribute filters", () => {
		const params = parseListParams({
			url: "/api/logs?limit=9999&lookback=9d&attr.session.id=abc&attrContains.message=failed",
		}, LOG_LIST, BASE_URL)

		expect(params.limit).toBe(500)
		expect(params.lookbackMinutes).toBe(24 * 60)
		expect(params.attributeFilters).toEqual({ "session.id": "abc" })
		expect(params.attributeContainsFilters).toEqual({ message: "failed" })
	})

	it("round-trips a trace cursor through page metadata", () => {
		const traces: readonly TraceSummaryItem[] = [
			{
				traceId: "trace-1",
				serviceName: "api",
				rootOperationName: "GET /first",
				startedAt: new Date(1000),
				isRunning: false,
				durationMs: 2,
				spanCount: 1,
				errorCount: 0,
				warnings: [],
			},
			{
				traceId: "trace-2",
				serviceName: "api",
				rootOperationName: "GET /second",
				startedAt: new Date(900),
				isRunning: false,
				durationMs: 1,
				spanCount: 1,
				errorCount: 0,
				warnings: [],
			},
		]

		const page = paginateSummaries(traces, { limit: 1, lookbackMinutes: 60 })
		const parsed = parseListParams({ url: `/api/traces?cursor=${page.meta.nextCursor}` }, LOG_LIST, BASE_URL)

		expect(page.meta.truncated).toBe(true)
		expect(traceCursorArgs(parsed.cursor)).toEqual({ cursorStartedAtMs: 1000, cursorTraceId: "trace-1" })
	})

	it("formats log page metadata and emits a cursor", () => {
		const logs: readonly LogItem[] = [{
			id: "12",
			timestamp: new Date(1200),
			serviceName: "api",
			severityText: "INFO",
			body: "ready",
			traceId: null,
			spanId: null,
			scopeName: null,
			attributes: {},
		}]

		const page = paginateLogs(logs, { limit: 10, lookbackMinutes: 120 })

		expect(page.meta).toMatchObject({ limit: 10, lookback: "2h", returned: 1, truncated: false })
		expect(page.meta.nextCursor).not.toBeNull()
	})

	it("keeps aggregate log queries bounded to twenty groups by default", () => {
		const params = parseListParams({ url: "/api/logs/stats?groupBy=service&agg=count" }, LOG_STATS, BASE_URL)

		expect(params.limit).toBe(20)
	})
})
