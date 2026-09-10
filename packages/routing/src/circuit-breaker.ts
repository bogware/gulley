import { NoopBreakerSync, type BreakerSync } from './breaker-sync';

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
  /** Optional cross-replica ejection sharing (default: no sharing). */
  sync?: BreakerSync;
  now?: () => number;
  /** Fire-and-forget observability hook, called once when a target transitions
   *  CLOSED → OPEN (ejected) — the key resiliency event to alert on. Never throws into
   *  the caller (invoked in a try/catch); does not affect breaker behavior. */
  onOpen?: (key: string) => void;
}

interface CircuitState {
  consecutiveFailures: number;
  /** EWMA of the error indicator (0 = healthy, 1 = all failing). */
  ewmaError: number;
  samples: number;
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
 * The breaker tracks UPSTREAM FAULTS only. Latency-based (passive) outlier
 * ejection lives in a separate `OutlierDetector` so the two planes never share a
 * backoff counter (see outlier.ts).
 *
 * State is per-replica by default. Supplying a {@link BreakerSync} additionally
 * shares OPEN state across replicas: an ejection is broadcast, and `isOpen` also
 * honors a peer's ejection — so a fleet-wide outage costs one replica's failure
 * budget, not every replica's. The graded EWMA logic stays local; only the
 * open/closed floor is shared (see breaker-sync.ts).
 */
export class CircuitBreaker {
  private readonly state = new Map<string, CircuitState>();
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly errorRateThreshold: number;
  private readonly minSamples: number;
  private readonly alpha: number;
  private readonly sync: BreakerSync;
  private readonly now: () => number;
  private readonly onOpen?: (key: string) => void;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.maxCooldownMs = opts.maxCooldownMs ?? 300_000;
    this.errorRateThreshold = opts.errorRateThreshold ?? 0.5;
    this.minSamples = opts.minSamples ?? 20;
    this.alpha = opts.alpha ?? 0.2;
    this.sync = opts.sync ?? new NoopBreakerSync();
    this.now = opts.now ?? ((): number => Date.now());
    this.onOpen = opts.onOpen;
  }

  isOpen(key: string): boolean {
    const now = this.now();
    const s = this.state.get(key);
    if (s && s.openUntil > now) return true;
    // A peer replica may have ejected this target even if we haven't locally.
    return this.sync.sharedOpenUntil(key) > now;
  }

  /** EWMA error rate (0..1) for observability / least-load selection. */
  errorRate(key: string): number {
    return this.state.get(key)?.ewmaError ?? 0;
  }

  private get(key: string): CircuitState {
    let s = this.state.get(key);
    if (!s) {
      s = { consecutiveFailures: 0, ewmaError: 0, samples: 0, ejections: 0, openUntil: 0 };
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
      const wasOpen = s.openUntil > this.now(); // distinguish a fresh ejection from a re-trip
      s.ejections += 1;
      const backoff = Math.min(this.cooldownMs * 2 ** (s.ejections - 1), this.maxCooldownMs);
      s.openUntil = this.now() + Math.max(backoff, retryAfterMs ?? 0);
      // Broadcast so peer replicas eject this target too (fire-and-forget).
      this.sync.publishOpen(key, s.openUntil);
      // Notify only on a CLOSED → OPEN transition (not every extend), best-effort.
      if (!wasOpen && this.onOpen) {
        try {
          this.onOpen(key);
        } catch {
          /* observability hook must never affect breaker behavior */
        }
      }
    }
  }
}
