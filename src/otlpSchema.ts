import { Schema } from "effect"
import type { OtlpAnyValue } from "./otlp.js"

const optional = Schema.optionalKey
const AnyValue: Schema.Codec<OtlpAnyValue> = Schema.suspend(() =>
	Schema.Struct({
		stringValue: optional(Schema.String),
		boolValue: optional(Schema.Boolean),
		intValue: optional(Schema.Union([Schema.String, Schema.Number])),
		doubleValue: optional(Schema.Number),
		bytesValue: optional(Schema.String),
		arrayValue: optional(Schema.Struct({ values: optional(Schema.Array(AnyValue)) })),
		kvlistValue: optional(Schema.Struct({ values: optional(Schema.Array(KeyValue)) })),
	}),
)
const KeyValue = Schema.Struct({ key: Schema.String, value: optional(AnyValue) })
const attributes = optional(Schema.Array(KeyValue))
const resource = optional(Schema.Struct({ attributes }))
const scope = optional(Schema.Struct({ name: optional(Schema.String) }))
/** Decode the OTLP trace fields consumed by the collector at an ingest boundary. */
export const TraceExport = Schema.Struct({
	resourceSpans: optional(
		Schema.Array(
			Schema.Struct({
				resource,
				scopeSpans: optional(
					Schema.Array(
						Schema.Struct({
							scope,
							spans: optional(
								Schema.Array(
									Schema.Struct({
										traceId: Schema.String,
										spanId: Schema.String,
										parentSpanId: optional(Schema.String),
										name: optional(Schema.String),
										kind: optional(Schema.Number),
										startTimeUnixNano: optional(Schema.String),
										endTimeUnixNano: optional(Schema.String),
										attributes,
										status: optional(Schema.Struct({ code: optional(Schema.Number), message: optional(Schema.String) })),
										events: optional(
											Schema.Array(Schema.Struct({ timeUnixNano: optional(Schema.String), name: optional(Schema.String), attributes })),
										),
									}),
								),
							),
						}),
					),
				),
			}),
		),
	),
})
/** Decode the OTLP log fields consumed by the collector at an ingest boundary. */
export const LogExport = Schema.Struct({
	resourceLogs: optional(
		Schema.Array(
			Schema.Struct({
				resource,
				scopeLogs: optional(
					Schema.Array(
						Schema.Struct({
							scope,
							logRecords: optional(
								Schema.Array(
									Schema.Struct({
										timeUnixNano: optional(Schema.String),
										observedTimeUnixNano: optional(Schema.String),
										severityText: optional(Schema.String),
										body: optional(AnyValue),
										attributes,
										traceId: optional(Schema.String),
										spanId: optional(Schema.String),
									}),
								),
							),
						}),
					),
				),
			}),
		),
	),
})
