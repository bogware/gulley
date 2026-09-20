import { type Counter, type Gauge, type Histogram, type Labels, Registry } from './registry';

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
  /** Cache-read / cache-write token breakdown of the inclusive input total. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costMicroUsd: number;
  startedAtMs: number;
  cacheStatus?: string;
  guardrailAction?: string;
  /** Dollars saved on this request (micro-USD): provider prompt caching, or the
   *  upstream cost avoided by a gateway response-cache hit. */
  cacheSavedMicroUsd?: number;
  /** Source of the saving: 'prompt_cache' (default) | 'response_cache'. */
  cacheSavedSource?: string;
  /** True when the served model had no catalog price (a cost-metering blind spot). */
  unpriced?: boolean;
}

// End-to-end proxied-request latency; wide upper buckets because streamed LLM
// responses routinely run for minutes.
const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300] as const;

// Budget-utilization buckets (used/cap at admission) — resiliency headroom signal.
const UTILIZATION_BUCKETS = [0.5, 0.7, 0.8, 0.9, 0.95, 1] as const;

// Hard cap on distinct `model` label values. The model on a non-2xx exit is the
// client-supplied, unverified request model, so a client sending {"model":"<random>"}
// each request would otherwise grow the (never-evicting) series map without bound — a
// metrics-cardinality / memory-DoS vector. Verified models beyond the cap fold into
// "__other__"; unverified (non-2xx) models are never emitted (see boundedModel).
const MAX_MODEL_LABELS = 1000;

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
  private readonly saved: Counter;
  private readonly unpriced: Counter;
  private readonly budgetAlerts: Counter;
  private readonly breakerStateChanges: Counter;
  private readonly hedges: Counter;
  private readonly classifierCost: Counter;
  private readonly classifierOutcomes: Counter;
  private readonly duration: Histogram;
  private readonly budgetUtilization: Histogram;
  // --- operational signals (were log-only or silent) ---
  private readonly sinkErrors: Counter;
  private readonly storeErrors: Counter;
  private readonly maintenanceRuns: Counter;
  private readonly requestLogDropped: Counter;
  private readonly sheds: Counter;
  private readonly aborts: Counter;
  private readonly unhandled: Counter;
  private readonly otelExportFailures: Counter;
  private readonly buildInfo: Gauge;
  private readonly maintenanceLastSuccess: Gauge;
  private readonly degraded: Gauge;
  /** Distinct verified model labels seen, to bound cardinality (see MAX_MODEL_LABELS). */
  private readonly modelLabels = new Set<string>();

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
    this.saved = this.registry.counter(
      'gulley_cost_saved_micro_usd_total',
      'Cost avoided in micro-USD by source (prompt_cache | response_cache).',
    );
    this.unpriced = this.registry.counter(
      'gulley_unpriced_requests_total',
      'Served requests whose model had no catalog price (metered $0 unless fail-closed), by provider and model.',
    );
    this.budgetAlerts = this.registry.counter(
      'gulley_budget_alerts_total',
      'Soft-threshold budget alerts fired, by threshold.',
    );
    this.breakerStateChanges = this.registry.counter(
      'gulley_breaker_state_changes_total',
      'Circuit-breaker state transitions by target and new state (open|closed|half_open).',
    );
    this.hedges = this.registry.counter(
      'gulley_hedge_total',
      'Request-hedging outcomes (fired|primary_won|hedge_won).',
    );
    this.classifierCost = this.registry.counter(
      'gulley_classifier_cost_micro_usd_total',
      'Smart-routing classifier sub-call spend in micro-USD.',
    );
    this.classifierOutcomes = this.registry.counter(
      'gulley_classifier_outcomes_total',
      'Smart-routing classifier outcomes by outcome (ok|abstain|timeout|error) — a ' +
        'rising timeout rate means the classify budget is mis-tuned (routing silently dead).',
    );
    this.duration = this.registry.histogram(
      'gulley_request_duration_seconds',
      'End-to-end proxied request duration in seconds.',
      DURATION_BUCKETS,
    );
    this.budgetUtilization = this.registry.histogram(
      'gulley_budget_utilization',
      'Workspace budget utilization (used/cap) sampled at admission.',
      UTILIZATION_BUCKETS,
    );
    this.sinkErrors = this.registry.counter(
      'gulley_sink_errors_total',
      'Teardown durable-sink write failures by sink (budget_commit|ledger|request_log|access_log|audit|cache_store|mask_vault).',
    );
    this.storeErrors = this.registry.counter(
      'gulley_store_errors_total',
      'Governance-store faults by store (budget|ratelimit|auth|cache) and the policy applied (fail_open|fail_closed|bypass|error).',
    );
    this.maintenanceRuns = this.registry.counter(
      'gulley_maintenance_runs_total',
      'Background maintenance runs by job (cache_sweep|mask_vault_sweep|request_log_retention|config_poll|budget_heal) and result (ok|error|skipped).',
    );
    this.requestLogDropped = this.registry.counter(
      'gulley_request_log_dropped_total',
      'request_log rows dropped because a batch flush failed.',
    );
    this.sheds = this.registry.counter(
      'gulley_shed_total',
      'Requests shed before dispatch by reason (half_open_probe|adaptive_limit|budget_store|capacity).',
    );
    this.aborts = this.registry.counter(
      'gulley_request_aborts_total',
      'Aborted in-flight requests by reason (client|watchdog|deadline|transform|guardrail|socket).',
    );
    this.unhandled = this.registry.counter(
      'gulley_unhandled_errors_total',
      'Pipeline exceptions caught by the route-level handler (a 5xx the client saw), by stage.',
    );
    this.otelExportFailures = this.registry.counter(
      'gulley_otel_export_failures_total',
      'OTLP export failures / dropped items by signal (traces|logs).',
    );
    this.buildInfo = this.registry.gauge(
      'gulley_build_info',
      'Build metadata (always 1); version/sha carried as labels.',
    );
    this.registry.gauge(
      'gulley_request_log_backlog',
      'request_log rows buffered and not yet flushed.',
      () => [{ value: this.backlogSampler?.() ?? 0 }],
    );
    this.maintenanceLastSuccess = this.registry.gauge(
      'gulley_maintenance_last_success_timestamp_seconds',
      'Unix time of the last successful run per maintenance job.',
    );
    this.degraded = this.registry.gauge(
      'gulley_gateway_degraded',
      '1 when the data plane is not serving (health-only boot / draining), by reason.',
    );
  }

  private backlogSampler: (() => number) | undefined;

  /** Wire the request-log backlog gauge to the batching sink's `backlog()`. */
  setRequestLogBacklogSampler(fn: () => number): void {
    this.backlogSampler = fn;
  }

  setBuildInfo(labels: Labels): void {
    this.buildInfo.set(labels, 1);
  }

  setDegraded(reason: string | undefined): void {
    this.degraded.set({ reason: reason ?? 'none' }, reason ? 1 : 0);
  }

  recordSinkError(sink: string): void {
    this.sinkErrors.inc({ sink });
  }

  recordStoreError(store: string, policy: string): void {
    this.storeErrors.inc({ store, policy });
  }

  recordMaintenance(job: string, result: 'ok' | 'error' | 'skipped'): void {
    this.maintenanceRuns.inc({ job, result });
    if (result === 'ok') this.maintenanceLastSuccess.set({ job }, Math.floor(this.now() / 1000));
  }

  recordRequestLogDropped(n: number): void {
    if (n > 0) this.requestLogDropped.inc({}, n);
  }

  recordShed(reason: string): void {
    this.sheds.inc({ reason });
  }

  recordAbort(reason: string): void {
    this.aborts.inc({ reason });
  }

  recordUnhandled(stage: string): void {
    this.unhandled.inc({ stage });
  }

  recordOtelExportFailure(signal: 'traces' | 'logs', n = 1): void {
    if (n > 0) this.otelExportFailures.inc({ signal }, n);
  }

  /** Bound the client-influenced `model` label. On a non-2xx exit the model is the
   *  unverified client request model — never emit it (cardinality-DoS). Otherwise cap
   *  the distinct verified models and fold the overflow into "__other__". */
  private boundedModel(d: RequestMetricData): string {
    if (d.statusCode >= 400) return '__unmetered__';
    const model = d.responseModel || d.requestModel || 'unknown';
    if (this.modelLabels.has(model)) return model;
    if (this.modelLabels.size >= MAX_MODEL_LABELS) return '__other__';
    this.modelLabels.add(model);
    return model;
  }

  record(d: RequestMetricData): void {
    const model = this.boundedModel(d);
    const base = { provider: d.provider, model };
    this.requests.inc({
      ...base,
      status: d.status,
      status_code: String(d.statusCode),
      streamed: String(d.streamed),
    });
    if (d.inputTokens > 0) this.tokens.inc({ ...base, type: 'input' }, d.inputTokens);
    if (d.outputTokens > 0) this.tokens.inc({ ...base, type: 'output' }, d.outputTokens);
    if (d.cacheReadTokens && d.cacheReadTokens > 0)
      this.tokens.inc({ ...base, type: 'cache_read' }, d.cacheReadTokens);
    if (d.cacheWriteTokens && d.cacheWriteTokens > 0)
      this.tokens.inc({ ...base, type: 'cache_write' }, d.cacheWriteTokens);
    if (d.costMicroUsd > 0) this.cost.inc(base, d.costMicroUsd);
    if (d.cacheStatus) this.cache.inc({ status: d.cacheStatus });
    if (d.guardrailAction) this.guardrail.inc({ action: d.guardrailAction });
    if (d.cacheSavedMicroUsd && d.cacheSavedMicroUsd > 0)
      this.saved.inc({ source: d.cacheSavedSource ?? 'prompt_cache' }, d.cacheSavedMicroUsd);
    if (d.unpriced) this.unpriced.inc(base);
    this.duration.observe(
      { provider: d.provider, status: d.status },
      Math.max(0, (this.now() - d.startedAtMs) / 1000),
    );
  }

  recordFailover(target: string): void {
    this.failovers.inc({ target });
  }

  recordBudgetAlert(threshold: number): void {
    this.budgetAlerts.inc({ threshold: String(threshold) });
  }

  /** A circuit-breaker state transition (the key resiliency signal — a dead upstream
   *  ejected from rotation). Emitted from the breaker's transition hook, not per-fault. */
  recordBreakerState(target: string, state: 'open' | 'closed' | 'half_open'): void {
    this.breakerStateChanges.inc({ target, state });
  }

  /** A hedging outcome: 'fired' when a hedge leg launches, then 'primary_won'/'hedge_won'. */
  recordHedge(outcome: 'fired' | 'primary_won' | 'hedge_won'): void {
    this.hedges.inc({ outcome });
  }

  /** Smart-routing classifier sub-call spend (micro-USD). */
  recordClassifierCost(microUsd: number): void {
    if (microUsd > 0) this.classifierCost.inc({}, microUsd);
  }

  /** Smart-routing classifier outcome (bounded 4-label set). A sustained `timeout`
   *  rate means the classify budget is below the embed/completer HTTP timeout, so
   *  classification aborts and semantic routing silently falls open. */
  recordClassifierOutcome(outcome: 'ok' | 'abstain' | 'timeout' | 'error'): void {
    this.classifierOutcomes.inc({ outcome });
  }

  /** Budget headroom at admission (used/cap), bucketed — no per-workspace label. */
  recordBudgetUtilization(utilization: number): void {
    this.budgetUtilization.observe({}, Math.max(0, utilization));
  }

  render(): string {
    return this.registry.render();
  }
}
