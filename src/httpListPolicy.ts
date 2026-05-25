import type { LogItem, TraceSummaryItem } from "./domain.js"
import { attributeContainsFiltersFromEntries, attributeFiltersFromEntries } from "./queryFilters.js"

type CursorShape =
	| { readonly kind: "trace"; readonly startedAt: number; readonly id: string }
	| { readonly kind: "log"; readonly timestamp: number; readonly id: string }

export interface ListBounds {
	readonly defaultLimit: number
	readonly maxLimit: number
	readonly defaultLookback: number
	readonly maxLookback: number
}

export interface ListParams {
	readonly url: URL
	readonly limit: number
	readonly lookbackMinutes: number
	readonly cursor: CursorShape | null
	readonly attributeFilters: Readonly<Record<string, string>>
	readonly attributeContainsFilters: Readonly<Record<string, string>>
}

export const TRACE_LIST: ListBounds = { defaultLimit: 20, maxLimit: 100, defaultLookback: 60, maxLookback: 24 * 60 }
export const SPAN_LIST: ListBounds = { defaultLimit: 100, maxLimit: 500, defaultLookback: 60, maxLookback: 24 * 60 }
export const LOG_LIST: ListBounds = { defaultLimit: 100, maxLimit: 500, defaultLookback: 60, maxLookback: 24 * 60 }
export const AI_LIST: ListBounds = { defaultLimit: 20, maxLimit: 500, defaultLookback: 60, maxLookback: 24 * 60 }
export const TRACE_STATS: ListBounds = { defaultLimit: 20, maxLimit: 100, defaultLookback: 60, maxLookback: 24 * 60 }
export const LOG_STATS: ListBounds = { defaultLimit: 20, maxLimit: 500, defaultLookback: 60, maxLookback: 24 * 60 }

export const requestUrl = (request: { readonly url: string }, baseUrl: string) => new URL(request.url, baseUrl)

const parsePositiveInt = (value: string | undefined, defaultValue: number) => {
	const parsed = Number.parseInt(value ?? "", 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue
}

export const parseLimit = (value: string | null, fallback: number) => parsePositiveInt(value ?? undefined, fallback)

export const parseLookbackMinutes = (value: string | null, fallback: number) => {
	if (!value) return fallback
	const match = value.trim().match(/^(\d+)([mhd])$/i)
	if (!match) return fallback
	const amount = Number.parseInt(match[1] ?? "", 10)
	if (!Number.isFinite(amount) || amount <= 0) return fallback
	const unit = (match[2] ?? "m").toLowerCase()
	if (unit === "d") return amount * 1440
	if (unit === "h") return amount * 60
	return amount
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max))

const decodeCursor = (value: string | null): CursorShape | null => {
	if (!value) return null
	try {
		return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as CursorShape
	} catch {
		return null
	}
}

const encodeCursor = (cursor: CursorShape) => Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")

export const traceCursorArgs = (cursor: CursorShape | null) =>
	cursor?.kind === "trace"
		? { cursorStartedAtMs: cursor.startedAt, cursorTraceId: cursor.id }
		: {}

export const logCursorArgs = (cursor: CursorShape | null) =>
	cursor?.kind === "log"
		? { cursorTimestampMs: cursor.timestamp, cursorId: cursor.id }
		: {}

export const parseListParams = (request: { readonly url: string }, bounds: ListBounds, baseUrl: string): ListParams => {
	const url = requestUrl(request, baseUrl)
	return {
		url,
		limit: clamp(parseLimit(url.searchParams.get("limit"), bounds.defaultLimit), 1, bounds.maxLimit),
		lookbackMinutes: clamp(parseLookbackMinutes(url.searchParams.get("lookback"), bounds.defaultLookback), 1, bounds.maxLookback),
		cursor: decodeCursor(url.searchParams.get("cursor")),
		attributeFilters: attributeFiltersFromEntries(url.searchParams.entries()),
		attributeContainsFilters: attributeContainsFiltersFromEntries(url.searchParams.entries()),
	}
}

const formatLookback = (minutes: number) => {
	if (minutes % 1440 === 0) return `${minutes / 1440}d`
	if (minutes % 60 === 0) return `${minutes / 60}h`
	return `${minutes}m`
}

export const listMeta = (input: { readonly limit: number; readonly lookbackMinutes: number; readonly returned: number; readonly truncated: boolean; readonly nextCursor: string | null }) => ({
	limit: input.limit,
	lookback: formatLookback(input.lookbackMinutes),
	returned: input.returned,
	truncated: input.truncated,
	nextCursor: input.nextCursor,
})

export const paginateSummaries = (summaries: readonly TraceSummaryItem[], options: { readonly limit: number; readonly lookbackMinutes: number }) => {
	const page = summaries.slice(0, options.limit)
	const last = page.at(-1)
	return {
		data: page,
		meta: listMeta({
			limit: options.limit,
			lookbackMinutes: options.lookbackMinutes,
			returned: page.length,
			truncated: summaries.length > page.length,
			nextCursor: last ? encodeCursor({ kind: "trace", startedAt: last.startedAt.getTime(), id: last.traceId }) : null,
		}),
	}
}

export const paginateLogs = (logs: readonly LogItem[], options: { readonly limit: number; readonly lookbackMinutes: number }) => {
	const page = logs.slice(0, options.limit)
	const last = page.at(-1)
	return {
		data: page,
		meta: listMeta({
			limit: options.limit,
			lookbackMinutes: options.lookbackMinutes,
			returned: page.length,
			truncated: logs.length > page.length,
			nextCursor: last ? encodeCursor({ kind: "log", timestamp: last.timestamp.getTime(), id: last.id }) : null,
		}),
	}
}
