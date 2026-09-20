import {
  type Attributes,
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  type Tracer,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

export interface RequestSpanData {
  provider: string;
  requestModel: string;
  responseModel: string;
  route: string;
  /** Data-residency region the upstream served from (omitted when unknown). */
  servedRegion?: string;
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
  /** Parent span id (16-hex) — the gateway's own generated span id, which it injected
   *  upstream as traceparent, so the emitted span shares the propagated trace id. */
  traceParentId?: string;
  /** Propagation sampling decision. false = the inbound/derived trace is NOT sampled,
   *  so the local span is dropped too (keeps local span volume in step with the
   *  forwarded sampled flag). undefined = no trace context (emit). */
  sampled?: boolean;
  /** Cache-read / cache-write token breakdown of the inclusive input total, surfaced
   *  so a trace can show cached-vs-fresh composition (prompt-cache effectiveness). */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Per-stage timings (epoch ms), materialized as child spans under the request
   *  span — recorded off the hot path (cheap marks), never per-chunk. */
  stages?: Array<{ name: string; startMs: number; endMs: number }>;
}

export interface Telemetry {
  recordRequest(data: RequestSpanData): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * The COMPLETE set of attributes attached to a request span, built purely from the
 * structured {@link RequestSpanData} (which carries no header or content field). Every
 * key is in the gen_ai.* / gulley.* / http.* allowlist and every value is a structured
 * datum — never a header, credential, or request/response body — so the always-on
 * no-credential-logging invariant (ARCHITECTURE §12) holds independent of the no-content
 * toggle. Exported so a regression test can assert that directly: a later change that
 * added a header-bearing or content attribute would fail the allowlist/absence assertions.
 */
export function spanAttributes(data: RequestSpanData): Attributes {
  return {
    'gen_ai.operation.name': 'chat',
    'gen_ai.provider.name': data.provider,
    'gen_ai.system': data.provider,
    'gen_ai.request.model': data.requestModel,
    'gen_ai.response.model': data.responseModel,
    'gen_ai.usage.input_tokens': data.inputTokens,
    'gen_ai.usage.output_tokens': data.outputTokens,
    'gulley.cost.micro_usd': data.costMicroUsd,
    ...(data.cacheReadTokens
      ? { 'gen_ai.usage.cache_read.input_tokens': data.cacheReadTokens }
      : {}),
    ...(data.cacheWriteTokens
      ? { 'gen_ai.usage.cache_creation.input_tokens': data.cacheWriteTokens }
      : {}),
    'gulley.route': data.route,
    'gulley.streamed': data.streamed,
    'http.response.status_code': data.statusCode,
    ...(data.stopReason ? { 'gen_ai.response.finish_reasons': [data.stopReason] } : {}),
    ...(data.servedRegion ? { 'gulley.served.region': data.servedRegion } : {}),
    ...(data.cacheStatus ? { 'gulley.cache.status': data.cacheStatus } : {}),
    ...(data.guardrailInputFindings !== undefined
      ? { 'gulley.guardrail.input.findings': data.guardrailInputFindings }
      : {}),
    ...(data.guardrailOutputFindings !== undefined
      ? { 'gulley.guardrail.output.findings': data.guardrailOutputFindings }
      : {}),
    ...(data.guardrailAction ? { 'gulley.guardrail.action': data.guardrailAction } : {}),
    ...(data.traceId ? { 'gulley.trace_id': data.traceId } : {}),
  };
}

/** Upper bound on one OTLP export attempt (and the batch processor's export budget). */
export const EXPORT_TIMEOUT_MS = 5_000;

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

  // Bounded export: the OTLP transport retries transient failures with backoff, and
  // shutdown()/forceFlush() await the final export — cap both so a dead collector
  // can never hold the SIGTERM drain hostage.
  const exporter = new OTLPTraceExporter({
    url: `${opts.endpoint.replace(/\/$/, '')}/v1/traces`,
    timeoutMillis: EXPORT_TIMEOUT_MS,
  });
  // Bounded, non-blocking export; drops rather than back-pressuring the hot path.
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': opts.serviceName ?? 'gulley-gateway' }),
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 1000,
        exportTimeoutMillis: EXPORT_TIMEOUT_MS,
      }),
    ],
  });
  provider.register();
  const tracer: Tracer = trace.getTracer('gulley-gateway');

  return {
    recordRequest(data): void {
      // Honor propagation sampling: when the forwarded trace is explicitly not sampled,
      // drop the local span too so sampleRatio actually controls span volume. Emit when
      // there is no trace context at all (sampled undefined) — OTel on without trace
      // propagation must still export.
      if (data.sampled === false) return;
      // Parent the span into the propagated trace so the gateway's leg shares the
      // client's/upstream's trace id (correlated in one trace, not an orphan under a
      // fresh random id). The SDK mints its own span id, so this unifies the trace id
      // rather than making the upstream leg a literal child — a real improvement.
      const parentCtx =
        data.traceId && data.traceParentId
          ? trace.setSpanContext(context.active(), {
              traceId: data.traceId,
              spanId: data.traceParentId,
              traceFlags: data.sampled ? 1 : 0,
              isRemote: true,
            })
          : undefined;
      const span = tracer.startSpan(
        `chat ${data.requestModel}`,
        { kind: SpanKind.CLIENT, startTime: data.startedAtMs },
        parentCtx,
      );
      span.setAttributes(spanAttributes(data));
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
