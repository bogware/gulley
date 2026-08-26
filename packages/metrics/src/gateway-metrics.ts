import { type Counter, type Histogram, Registry } from './registry';

/**
 * The per-request data metrics consume — a structural subset of the telemetry
 * `RequestSpanData`, so the gateway can tee one `recordRequest` call to both OTel
 * and Prometheus with no extra hot-path plumbing.
 */
export interface RequestMetricData {
  provider: string;
  requestModel: string;
  responseModel: string;
  status: string;
  statusCode: number;
  streamed: boolean;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  startedAtMs: number;
  cacheStatus?: string;
  guardrailAction?: string;
}

// End-to-end proxied-request latency; wide upper buckets because streamed LLM
// responses routinely run for minutes.
const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300] as const;

/**
 * The gateway's Prometheus instruments. `record` derives the bulk of them from a
 * single telemetry event (requests, tokens, cost, cache, guardrail action,
 * duration); `recordFailover` is the one signal not carried on a request event.
 */
export class GatewayMetrics {
  readonly registry = new Registry();
  private readonly requests: Counter;
  private readonly tokens: Counter;
  private readonly cost: Counter;
  private readonly cache: Counter;
  private readonly guardrail: Counter;
  private readonly failovers: Counter;
  private readonly duration: Histogram;

  constructor(private readonly now: () => number = Date.now) {
    this.requests = this.registry.counter(
      'gulley_requests_total',
      'Proxied requests by provider, model, status, and HTTP status code.',
    );
    this.tokens = this.registry.counter(
      'gulley_tokens_total',
      'Tokens metered by provider, model, and type (input|output).',
    );
    this.cost = this.registry.counter(
      'gulley_cost_micro_usd_total',
      'Metered cost in micro-USD by provider and model.',
    );
    this.cache = this.registry.counter(
      'gulley_cache_events_total',
      'Cache lookups by status (hit-exact|hit-semantic|miss|bypass).',
    );
    this.guardrail = this.registry.counter(
      'gulley_guardrail_actions_total',
      'Guardrail enforcement actions by action (block|mask|redact).',
    );
    this.failovers = this.registry.counter(
      'gulley_failovers_total',
      'Pre-first-byte failovers by target.',
    );
    this.duration = this.registry.histogram(
      'gulley_request_duration_seconds',
      'End-to-end proxied request duration in seconds.',
      DURATION_BUCKETS,
    );
  }

  record(d: RequestMetricData): void {
    const model = d.responseModel || d.requestModel || 'unknown';
    const base = { provider: d.provider, model };
    this.requests.inc({
      ...base,
      status: d.status,
      status_code: String(d.statusCode),
      streamed: String(d.streamed),
    });
    if (d.inputTokens > 0) this.tokens.inc({ ...base, type: 'input' }, d.inputTokens);
    if (d.outputTokens > 0) this.tokens.inc({ ...base, type: 'output' }, d.outputTokens);
    if (d.costMicroUsd > 0) this.cost.inc(base, d.costMicroUsd);
    if (d.cacheStatus) this.cache.inc({ status: d.cacheStatus });
    if (d.guardrailAction) this.guardrail.inc({ action: d.guardrailAction });
    this.duration.observe(
      { provider: d.provider, status: d.status },
      Math.max(0, (this.now() - d.startedAtMs) / 1000),
    );
  }

  recordFailover(target: string): void {
    this.failovers.inc({ target });
  }

  render(): string {
    return this.registry.render();
  }
}
