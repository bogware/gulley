export interface AdaptiveLimiterOptions {
  /** Lower bound on a target's concurrency limit (never gate below this). */
  minLimit?: number;
  /** Upper bound on a target's concurrency limit. */
  maxLimit?: number;
  /** Starting limit for a freshly-seen target. */
  initialLimit?: number;
  /** Multiplicative decrease applied on a dropped sample (0..1). */
  backoffRatio?: number;
  /** EWMA smoothing for limit updates (0..1); higher = more reactive. */
  smoothing?: number;
  now?: () => number;
}

interface TargetState {
  limit: number;
  inflight: number;
  /** Rolling minimum observed RTT — the uncongested baseline (ms). */
  rttNoLoad: number;
}

/**
 * Per-target adaptive concurrency limiter (a gradient limiter, à la Netflix
 * concurrency-limits). Each target carries a DYNAMIC in-flight ceiling that rises
 * while the target answers near its no-load latency and falls when latency climbs
 * or requests drop — so the gateway stops piling work onto a degrading upstream
 * before its latency collapses for everyone. It complements, and is orthogonal to,
 * the P2C {@link LoadScoreboard} (which spreads load but never caps it) and the
 * fault {@link CircuitBreaker} (which ejects on errors, not saturation).
 *
 * `tryAcquire` is the gate (admit iff in-flight is below the current limit); every
 * acquired slot MUST be released with exactly one `record()` carrying the observed
 * RTT and whether the request dropped (5xx / timeout / connection error). All
 * state is per-replica in-memory.
 */
export class AdaptiveLimiter {
  private readonly state = new Map<string, TargetState>();
  private readonly minLimit: number;
  private readonly maxLimit: number;
  private readonly initialLimit: number;
  private readonly backoffRatio: number;
  private readonly smoothing: number;

  constructor(opts: AdaptiveLimiterOptions = {}) {
    this.minLimit = Math.max(1, opts.minLimit ?? 4);
    this.maxLimit = Math.max(this.minLimit, opts.maxLimit ?? 200);
    this.initialLimit = Math.min(this.maxLimit, Math.max(this.minLimit, opts.initialLimit ?? 20));
    this.backoffRatio = Math.min(0.99, Math.max(0.5, opts.backoffRatio ?? 0.9));
    this.smoothing = Math.min(1, Math.max(0.01, opts.smoothing ?? 0.2));
  }

  private get(name: string): TargetState {
    let s = this.state.get(name);
    if (!s) {
      s = { limit: this.initialLimit, inflight: 0, rttNoLoad: Number.POSITIVE_INFINITY };
      this.state.set(name, s);
    }
    return s;
  }

  /** Admit a request iff in-flight is below the current (floored) limit. On
   *  admission the slot is held until the matching {@link record}. */
  tryAcquire(name: string): boolean {
    const s = this.get(name);
    const ceiling = Math.max(this.minLimit, Math.floor(s.limit));
    if (s.inflight >= ceiling) return false;
    s.inflight += 1;
    return true;
  }

  /** Release a slot and adapt the limit from the observed RTT. `dropped` marks a
   *  fault/timeout (multiplicative decrease); otherwise the gradient rule applies. */
  record(name: string, rttMs: number, dropped: boolean): void {
    const s = this.get(name);
    s.inflight = Math.max(0, s.inflight - 1);

    if (dropped) {
      s.limit = Math.max(this.minLimit, s.limit * this.backoffRatio);
      return;
    }

    const rtt = Math.max(1, rttMs);
    // Track the no-load baseline (the fastest we've seen this target answer).
    if (rtt < s.rttNoLoad) s.rttNoLoad = rtt;

    // Only grow while near saturation — otherwise idle traffic (in-flight far
    // below the limit) would inflate the ceiling unboundedly on fast samples.
    if (s.inflight + 1 < s.limit / 2) return;

    const gradient = Math.max(0.5, Math.min(1, s.rttNoLoad / rtt));
    const queue = Math.sqrt(s.limit);
    const newLimit = s.limit * gradient + queue;
    s.limit = Math.min(
      this.maxLimit,
      Math.max(this.minLimit, s.limit * (1 - this.smoothing) + newLimit * this.smoothing),
    );
  }

  /** Release a slot WITHOUT adapting the limit — for a request that was cancelled
   *  (e.g. a hedge loser aborted mid-flight), whose latency is not a real signal. */
  release(name: string): void {
    const s = this.get(name);
    s.inflight = Math.max(0, s.inflight - 1);
  }

  /** Current concurrency limit (floored) for `name`. */
  currentLimit(name: string): number {
    return Math.max(this.minLimit, Math.floor(this.get(name).limit));
  }

  /** Current in-flight count for `name`. */
  inFlight(name: string): number {
    return this.get(name).inflight;
  }
}
