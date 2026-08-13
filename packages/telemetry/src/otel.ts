import { SpanKind, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

export interface RequestSpanData {
  provider: string;
  requestModel: string;
  responseModel: string;
  route: string;
  statusCode: number;
  status: string;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  streamed: boolean;
  stopReason?: string | null;
  /** Epoch ms when the request started, so the span reflects real latency. */
  startedAtMs: number;
}

export interface Telemetry {
  recordRequest(data: RequestSpanData): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

const NOOP: Telemetry = {
  recordRequest: () => {},
  forceFlush: async () => {},
  shutdown: async () => {},
};

export interface TelemetryOptions {
  /** OTLP/HTTP base URL, e.g. http://localhost:4318. Absent = telemetry disabled. */
  endpoint?: string | undefined;
  serviceName?: string;
}

/**
 * Emit one CLIENT span per proxied request using OpenTelemetry GenAI semantic
 * conventions. Export is async + bounded (BatchSpanProcessor queue never blocks
 * the proxy). Content is OFF by default — only structured, credential-free
 * attributes are attached, so nothing sensitive can leak into a span.
 */
export function initTelemetry(opts: TelemetryOptions): Telemetry {
  if (!opts.endpoint) return NOOP;

  const exporter = new OTLPTraceExporter({
    url: `${opts.endpoint.replace(/\/$/, '')}/v1/traces`,
  });
  const provider = new NodeTracerProvider({
    resource: new Resource({ 'service.name': opts.serviceName ?? 'gulley-gateway' }),
  });
  // Bounded, non-blocking export; drops rather than back-pressuring the hot path.
  provider.addSpanProcessor(
    new BatchSpanProcessor(exporter, {
      maxQueueSize: 2048,
      maxExportBatchSize: 512,
      scheduledDelayMillis: 1000,
    }),
  );
  provider.register();
  const tracer: Tracer = trace.getTracer('gulley-gateway');

  return {
    recordRequest(data): void {
      const span = tracer.startSpan(`chat ${data.requestModel}`, {
        kind: SpanKind.CLIENT,
        startTime: data.startedAtMs,
      });
      span.setAttributes({
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': data.provider,
        'gen_ai.system': data.provider,
        'gen_ai.request.model': data.requestModel,
        'gen_ai.response.model': data.responseModel,
        'gen_ai.usage.input_tokens': data.inputTokens,
        'gen_ai.usage.output_tokens': data.outputTokens,
        'gulley.cost.micro_usd': data.costMicroUsd,
        'gulley.route': data.route,
        'gulley.streamed': data.streamed,
        'http.response.status_code': data.statusCode,
      });
      if (data.stopReason) {
        span.setAttribute('gen_ai.response.finish_reasons', [data.stopReason]);
      }
      if (data.status !== 'ok') {
        span.setStatus({ code: SpanStatusCode.ERROR, message: data.status });
      }
      span.end();
    },
    forceFlush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}
