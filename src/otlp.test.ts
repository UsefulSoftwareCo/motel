import rootModule from "@opentelemetry/otlp-transformer/build/esm/generated/root.js"
import { describe, expect, test } from "bun:test"
import { normalizeOtlpBinaryId } from "./otlp.ts"
import { decodeProtobufLogs, decodeProtobufTraces } from "./otlpProtobuf.ts"

describe("normalizeOtlpBinaryId", () => {
	test("normalizes hex and canonical base64 IDs", () => {
		expect(normalizeOtlpBinaryId("0123456789ABCDEF", 8)).toBe("0123456789abcdef")
		expect(normalizeOtlpBinaryId(Buffer.from("0123456789abcdef", "hex").toString("base64"), 8)).toBe("0123456789abcdef")
		expect(normalizeOtlpBinaryId(Buffer.from("0123456789abcdef0123456789abcdef", "hex").toString("base64"), 16)).toBe("0123456789abcdef0123456789abcdef")
	})

	test("preserves non-standard human-readable IDs", () => {
		expect(normalizeOtlpBinaryId("ai-stream-1", 8)).toBe("ai-stream-1")
		expect(normalizeOtlpBinaryId("ai-stream-2", 8)).toBe("ai-stream-2")
		expect(normalizeOtlpBinaryId("trace-ai", 16)).toBe("trace-ai")
	})

	test("returns null for absent IDs", () => {
		expect(normalizeOtlpBinaryId(null, 16)).toBeNull()
		expect(normalizeOtlpBinaryId(undefined, 8)).toBeNull()
		expect(normalizeOtlpBinaryId("", 16)).toBeNull()
	})
})

const root = rootModule as unknown as {
	readonly opentelemetry: {
		readonly proto: {
			readonly collector: {
				readonly trace: { readonly v1: { readonly ExportTraceServiceRequest: { encode: (message: unknown) => { finish: () => Uint8Array } } } }
				readonly logs: { readonly v1: { readonly ExportLogsServiceRequest: { encode: (message: unknown) => { finish: () => Uint8Array } } } }
			}
		}
	}
}

describe("protobuf OTLP decoders", () => {
	test("decodes traces into the JSON ingest shape", () => {
		const encoded = root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest.encode({
			resourceSpans: [{
				resource: { attributes: [{ key: "service.name", value: { stringValue: "proto-svc" } }] },
				scopeSpans: [{ spans: [{
					traceId: Buffer.from("0123456789abcdef0123456789abcdef", "hex"),
					spanId: Buffer.from("0123456789abcdef", "hex"),
					name: "op",
					startTimeUnixNano: 1,
					endTimeUnixNano: 2,
				}] }],
			}],
		}).finish()
		const span = decodeProtobufTraces(encoded).resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]
		expect(span?.name).toBe("op")
		expect(normalizeOtlpBinaryId(span?.traceId, 16)).toBe("0123456789abcdef0123456789abcdef")
		expect(normalizeOtlpBinaryId(span?.spanId, 8)).toBe("0123456789abcdef")
	})

	test("decodes logs into the JSON ingest shape", () => {
		const encoded = root.opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest.encode({
			resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: 5, severityText: "INFO", body: { stringValue: "hello" } }] }] }],
		}).finish()
		const record = decodeProtobufLogs(encoded).resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords?.[0]
		expect(record?.severityText).toBe("INFO")
		expect(record?.body?.stringValue).toBe("hello")
	})
})
