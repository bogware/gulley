export interface OutlierDetectorOptions {
  /** EWMA smoothing factor (0..1); higher = more reactive. */
  alpha?: number;
  /** Minimum latency observations before a target can be ejected. */
  minSamples?: number;
  /** Eject when a target's EWMA latency ≥ peerBaseline × this factor. */
  latencyFactor?: number;
  /** Never eject below this absolute EWMA (ms) — avoids ejecting on noise when
   *  every target is fast and one is only marginally slower. */
  minEjectLatencyMs?: number;
  /** Base ejection duration (ms); backoff-scaled on repeats, capped by max. */
  baseEjectMs?: number;
  maxEjectMs?: number;
  now?: () => number;
}

interface OutlierState {
  ewmaLatency: number;
  samples: number;
  /** Successive ejections, for this detector's OWN multiplicative backoff. */
  ejections: number;
  ejectedUntil: number;
}

/**
 * Passive outlier detection: ejects a target that is slow *relative to its peers*
 * (a TTFB EWMA at least `latencyFactor`× the peer baseline), even when it never
 * errors — the latency companion to the fault {@link CircuitBreaker}. It is a
 * SEPARATE class on purpose: it keeps its own ejection/backoff state so the two
 * planes never cross-contaminate, and its self-heal is correct — a re-admitted
 * target's first fresh sample RESETS the EWMA (rather than blending the stale,
 * frozen-high value it held while ejected), so a recovered target clears
 * immediately instead of being dragged out for minutes by EWMA inertia.
 *
 * Peer-relative (not absolute) because LLM TTFB varies wildly by provider/model:
 * when the whole pool is uniformly slow, no member is an outlier and none is
 * ejected (that is an upstream-wide problem, not a routing one). With no eligible
 * peer (a single target, or all peers still warming up) a target is never
 * ejected — you must not latency-eject your only usable upstream.
 *
 * All state is per-replica in-memory, exactly like the breaker and scoreboard.
 */
export class OutlierDetector {
  private readonly state = new Map<string, OutlierState>();
  private readonly alpha: number;
  private readonly minSamples: number;
  private readonly latencyFactor: number;
  private readonly minEjectLatencyMs: number;
  private readonly baseEjectMs: number;
  private readonly maxEjectMs: number;
  private readonly now: () => number;

  constructor(opts: OutlierDetectorOptions = {}) {
    this.alpha = opts.alpha ?? 0.3;
    this.minSamples = opts.minSamples ?? 20;
    this.latencyFactor = opts.latencyFactor ?? 3;
    this.minEjectLatencyMs = opts.minEjectLatencyMs ?? 500;
    this.baseEjectMs = opts.baseEjectMs ?? 30_000;
    this.maxEjectMs = opts.maxEjectMs ?? 300_000;
    this.now = opts.now ?? ((): number => Date.now());
  }

  isEjected(key: string): boolean {
    const s = this.state.get(key);
    return s ? s.ejectedUntil > this.now() : false;
  }

  /** EWMA latency (ms) for observability / a future latency-aware P2C. */
  latency(key: string): number {
    return this.state.get(key)?.ewmaLatency ?? 0;
  }

  private get(key: string): OutlierState {
    let s = this.state.get(key);
    if (!s) {
      s = { ewmaLatency: 0, samples: 0, ejections: 0, ejectedUntil: 0 };
      this.state.set(key, s);
    }
    return s;
  }

  /**
   * Record an observed latency (time-to-response-headers) for `key`, judged
   * against `peerKeys` (the candidate pool). Ejects/un-ejects as a side effect.
   */
  recordLatency(key: string, ms: number, peerKeys: readonly string[] = []): void {
    const s = this.get(key);
    const now = this.now();

    // Re-admitted after an ejection window: trust the fresh probe, don't blend
    // the stale frozen-high EWMA (that inertia is what breaks self-heal).
    const reAdmitted = s.ejectedUntil > 0 && now >= s.ejectedUntil;
    if (reAdmitted) {
      s.ewmaLatency = ms;
      s.ejectedUntil = 0;
    } else if (s.samples === 0) {
      s.ewmaLatency = ms;
    } else {
      s.ewmaLatency = s.ewmaLatency * (1 - this.alpha) + this.alpha * ms;
    }
    s.samples += 1;

    const baseline = this.peerBaseline(key, peerKeys, now);
    const threshold =
      baseline === undefined
        ? undefined
        : Math.max(baseline * this.latencyFactor, this.minEjectLatencyMs);
    const slow =
      threshold !== undefined && s.samples >= this.minSamples && s.ewmaLatency >= threshold;

    if (slow && s.ejectedUntil <= now) {
      s.ejections += 1;
      s.ejectedUntil = now + Math.min(this.baseEjectMs * 2 ** (s.ejections - 1), this.maxEjectMs);
    } else if (!slow) {
      // A healthy (or unjudgeable) sample resets the backoff, so a recovered
      // target earns the base ejection duration again next time.
      s.ejections = 0;
    }
  }

  /** Mean EWMA latency of eligible peers: min-sampled, currently un-ejected, and
   *  not the target itself. Undefined when there is no eligible peer. */
  private peerBaseline(key: string, peerKeys: readonly string[], now: number): number | undefined {
    let sum = 0;
    let count = 0;
    for (const p of peerKeys) {
      if (p === key) continue;
      const ps = this.state.get(p);
      if (ps && ps.samples >= this.minSamples && ps.ejectedUntil <= now) {
        sum += ps.ewmaLatency;
        count += 1;
      }
    }
    return count === 0 ? undefined : sum / count;
  }
}
