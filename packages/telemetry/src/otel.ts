import { context, SpanKind, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';
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
  /** Cache tier outcome: hit-exact | hit-semantic | miss | bypass. */
  cacheStatus?: string;
  /** Guardrail finding counts (structured — never the matched content). */
  guardrailInputFindings?: number;
  guardrailOutputFindings?: number;
  /** The enforcing action taken, if any: block | mask | redact. */
  guardrailAction?: string;
  /** Dollars saved on this request (micro-USD): provider prompt caching on a miss,
   *  or the full upstream cost avoided on a gateway response-cache hit. */
  cacheSavedMicroUsd?: number;
  /** Which cache avoided the cost: 'prompt_cache' (provider) | 'response_cache'
   *  (this gateway's two-tier cache). Defaults to prompt_cache when unset. */
  cacheSavedSource?: string;
  /** True when the served model had no catalog price (metered $0 unless fail-closed)
   *  — a cost-governance blind spot worth surfacing. */
  unpriced?: boolean;
  /** W3C trace id (32-hex) this request belongs to, for cross-system correlation. */
  traceId?: string;
  /** Per-stage timings (epoch ms), materialized as child spans under the request
   *  span — recorded off the hot path (cheap marks), never per-chunk. */
  stages?: Array<{ name: string; startMs: number; endMs: number }>;
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
      if (data.cacheStatus) span.setAttribute('gulley.cache.status', data.cacheStatus);
      if (data.guardrailInputFindings !== undefined) {
        span.setAttribute('gulley.guardrail.input.findings', data.guardrailInputFindings);
      }
      if (data.guardrailOutputFindings !== undefined) {
        span.setAttribute('gulley.guardrail.output.findings', data.guardrailOutputFindings);
      }
      if (data.guardrailAction) span.setAttribute('gulley.guardrail.action', data.guardrailAction);
      if (data.traceId) span.setAttribute('gulley.trace_id', data.traceId);
      if (data.status !== 'ok') {
        span.setStatus({ code: SpanStatusCode.ERROR, message: data.status });
      }
      // Materialize per-stage child spans under the request span (buffered marks,
      // never per-chunk) so a trace shows where the latency actually went.
      if (data.stages && data.stages.length > 0) {
        const parentCtx = trace.setSpan(context.active(), span);
        for (const s of data.stages) {
          if (s.endMs >= s.startMs) {
            tracer.startSpan(s.name, { startTime: s.startMs }, parentCtx).end(s.endMs);
          }
        }
      }
      span.end();
    },
    forceFlush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}
