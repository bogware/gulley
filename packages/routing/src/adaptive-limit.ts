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
  /** How long a no-load baseline sample stays authoritative before it is replaced by
   *  the following window's minimum (ms). An all-time minimum never forgot one
   *  freak-fast sample, so every later normal-length generation looked congested and
   *  the limit ratcheted down to minLimit on a healthy target. Default 60 s. */
  baselineWindowMs?: number;
  now?: () => number;
}

interface TargetState {
  limit: number;
  inflight: number;
  /** Minimum RTT seen in the PREVIOUS baseline window (the current baseline). */
  baseline: number;
  /** Minimum RTT seen in the current window (becomes the baseline at rollover). */
  windowMin: number;
  windowStartMs: number;
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
  private readonly baselineWindowMs: number;
  private readonly now: () => number;

  constructor(opts: AdaptiveLimiterOptions = {}) {
    this.baselineWindowMs = Math.max(1_000, opts.baselineWindowMs ?? 60_000);
    this.now = opts.now ?? ((): number => Date.now());
    this.minLimit = Math.max(1, opts.minLimit ?? 4);
    this.maxLimit = Math.max(this.minLimit, opts.maxLimit ?? 200);
    this.initialLimit = Math.min(this.maxLimit, Math.max(this.minLimit, opts.initialLimit ?? 20));
    this.backoffRatio = Math.min(0.99, Math.max(0.5, opts.backoffRatio ?? 0.9));
    this.smoothing = Math.min(1, Math.max(0.01, opts.smoothing ?? 0.2));
  }

  private get(name: string): TargetState {
    let s = this.state.get(name);
    if (!s) {
      s = {
        limit: this.initialLimit,
        inflight: 0,
        baseline: Number.POSITIVE_INFINITY,
        windowMin: Number.POSITIVE_INFINITY,
        windowStartMs: this.now(),
      };
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
    // Track the no-load baseline as a WINDOWED minimum: the fastest sample of the
    // previous window (with the current window's minimum as a floor) — so a single
    // unusually fast answer ages out instead of defining "uncongested" forever.
    const now = this.now();
    if (now - s.windowStartMs >= this.baselineWindowMs) {
      s.baseline = s.windowMin;
      s.windowMin = Number.POSITIVE_INFINITY;
      s.windowStartMs = now;
    }
    if (rtt < s.windowMin) s.windowMin = rtt;
    const rttNoLoad = Math.min(s.baseline, s.windowMin);

    // Only grow while near saturation — otherwise idle traffic (in-flight far
    // below the limit) would inflate the ceiling unboundedly on fast samples.
    if (s.inflight + 1 < s.limit / 2) return;

    const gradient = Math.max(0.5, Math.min(1, rttNoLoad / rtt));
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
