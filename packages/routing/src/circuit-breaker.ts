export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. */
  failureThreshold?: number;
  /** Base cooldown the circuit stays open before a half-open retry. */
  cooldownMs?: number;
  /** Upper bound on the (backoff-scaled) cooldown. */
  maxCooldownMs?: number;
  /** EWMA error-rate at/above which a target is ejected (graded, not just
   *  consecutive) once `minSamples` have been seen. */
  errorRateThreshold?: number;
  /** Minimum observations before the error-rate rule can trip. */
  minSamples?: number;
  /** EWMA smoothing factor (0..1); higher = more reactive. */
  alpha?: number;
  /** EWMA latency (ms) at/above which a target is passively ejected as a slow
   *  outlier — even with zero errors. Undefined = latency ejection disabled. */
  latencyThresholdMs?: number;
  /** Minimum latency observations before the latency rule can trip. */
  minLatencySamples?: number;
  /** Base duration a latency-ejected target stays out (backoff-scaled on repeats,
   *  capped by `maxCooldownMs`). Defaults to `cooldownMs`. */
  latencyEjectionMs?: number;
  now?: () => number;
}

interface CircuitState {
  consecutiveFailures: number;
  /** EWMA of the error indicator (0 = healthy, 1 = all failing). */
  ewmaError: number;
  samples: number;
  /** EWMA of observed upstream latency (ms); 0 until the first sample. */
  ewmaLatency: number;
  latencySamples: number;
  /** Successive ejections, for multiplicative backoff; reset on recovery. */
  ejections: number;
  openUntil: number;
}

/**
 * Per-target circuit breaker with graded, self-healing ejection. A target opens
 * either on `failureThreshold` consecutive failures OR when its EWMA error rate
 * crosses `errorRateThreshold` (after `minSamples`) — catching a target that
 * fails half its calls without ever hitting a consecutive streak. The open
 * duration is the base cooldown scaled by multiplicative backoff on repeated
 * ejections (capped), and never shorter than an upstream-supplied `Retry-After`.
 * A half-open success clears the failure state and resets the backoff.
 *
 * Passive outlier detection (opt-in): when `latencyThresholdMs` is set, a target
 * whose EWMA latency crosses it is ejected as a slow outlier even if it never
 * errors, and un-ejected by time (a half-open probe re-measures it — fast clears
 * it, slow re-ejects). This is independent of the error/failure rules above.
 */
export class CircuitBreaker {
  private readonly state = new Map<string, CircuitState>();
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly errorRateThreshold: number;
  private readonly minSamples: number;
  private readonly alpha: number;
  private readonly latencyThresholdMs: number | undefined;
  private readonly minLatencySamples: number;
  private readonly latencyEjectionMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.maxCooldownMs = opts.maxCooldownMs ?? 300_000;
    this.errorRateThreshold = opts.errorRateThreshold ?? 0.5;
    this.minSamples = opts.minSamples ?? 20;
    this.alpha = opts.alpha ?? 0.2;
    this.latencyThresholdMs = opts.latencyThresholdMs;
    this.minLatencySamples = opts.minLatencySamples ?? 20;
    this.latencyEjectionMs = opts.latencyEjectionMs ?? this.cooldownMs;
    this.now = opts.now ?? ((): number => Date.now());
  }

  isOpen(key: string): boolean {
    const s = this.state.get(key);
    return s ? s.openUntil > this.now() : false;
  }

  /** EWMA error rate (0..1) for observability / least-load selection. */
  errorRate(key: string): number {
    return this.state.get(key)?.ewmaError ?? 0;
  }

  /** EWMA upstream latency (ms) for observability / least-load selection. */
  latencyMs(key: string): number {
    return this.state.get(key)?.ewmaLatency ?? 0;
  }

  private get(key: string): CircuitState {
    let s = this.state.get(key);
    if (!s) {
      s = {
        consecutiveFailures: 0,
        ewmaError: 0,
        samples: 0,
        ewmaLatency: 0,
        latencySamples: 0,
        ejections: 0,
        openUntil: 0,
      };
      this.state.set(key, s);
    }
    return s;
  }

  recordSuccess(key: string): void {
    const s = this.get(key);
    s.consecutiveFailures = 0;
    s.ewmaError = s.ewmaError * (1 - this.alpha);
    s.samples += 1;
    // Recovered on a half-open probe → clear the backoff so the next fault
    // starts from the base cooldown again.
    if (s.openUntil <= this.now()) s.ejections = 0;
  }

  /** Record a failure. `retryAfterMs` (parsed from an upstream Retry-After / rate
   *  limit header) sets a floor on the resulting cooldown. */
  recordFailure(key: string, retryAfterMs?: number): void {
    const s = this.get(key);
    s.consecutiveFailures += 1;
    s.ewmaError = s.ewmaError * (1 - this.alpha) + this.alpha;
    s.samples += 1;

    const tripConsecutive = s.consecutiveFailures >= this.threshold;
    const tripRate = s.samples >= this.minSamples && s.ewmaError >= this.errorRateThreshold;
    if (tripConsecutive || tripRate) {
      s.ejections += 1;
      const backoff = Math.min(this.cooldownMs * 2 ** (s.ejections - 1), this.maxCooldownMs);
      s.openUntil = this.now() + Math.max(backoff, retryAfterMs ?? 0);
    }
  }

  /** Record an observed upstream latency (ms). Feeds the EWMA used for passive
   *  outlier ejection (when `latencyThresholdMs` is set) and observability. */
  recordLatency(key: string, ms: number): void {
    const s = this.get(key);
    s.ewmaLatency =
      s.latencySamples === 0 ? ms : s.ewmaLatency * (1 - this.alpha) + this.alpha * ms;
    s.latencySamples += 1;

    if (
      this.latencyThresholdMs !== undefined &&
      s.latencySamples >= this.minLatencySamples &&
      s.ewmaLatency >= this.latencyThresholdMs &&
      s.openUntil <= this.now() // don't extend an already-open circuit
    ) {
      s.ejections += 1;
      const backoff = Math.min(this.latencyEjectionMs * 2 ** (s.ejections - 1), this.maxCooldownMs);
      s.openUntil = this.now() + backoff;
    }
  }
}
