import rootModule from "@opentelemetry/otlp-transformer/build/esm/generated/root.js"
import type { OtlpLogExportRequest, OtlpTraceExportRequest } from "./otlp.js"

interface ProtobufType {
	readonly decode: (bytes: Uint8Array) => unknown
	readonly toObject: (message: unknown, options: Record<string, unknown>) => unknown
}

const root = rootModule as unknown as {
	readonly opentelemetry: {
		readonly proto: {
			readonly collector: {
				readonly trace: { readonly v1: { readonly ExportTraceServiceRequest: ProtobufType } }
				readonly logs: { readonly v1: { readonly ExportLogsServiceRequest: ProtobufType } }
			}
		}
	}
}

const ExportTraceServiceRequest = root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest
const ExportLogsServiceRequest = root.opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest
const decodeOptions = {
	bytes: String,
	longs: String,
	defaults: false,
	enums: Number,
	arrays: true,
	objects: true,
}

export const decodeProtobufTraces = (bytes: Uint8Array): OtlpTraceExportRequest =>
	ExportTraceServiceRequest.toObject(ExportTraceServiceRequest.decode(bytes), decodeOptions) as OtlpTraceExportRequest

export const decodeProtobufLogs = (bytes: Uint8Array): OtlpLogExportRequest =>
	ExportLogsServiceRequest.toObject(ExportLogsServiceRequest.decode(bytes), decodeOptions) as OtlpLogExportRequest
