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
  /** How long a single half-open probe token is held before it self-heals. A probe
   *  that is granted but never dispatched (ordered behind a healthier primary) or that
   *  hangs must not wedge the target half-open forever, so the token expires after this
   *  bound and another caller may probe (default 10s). */
  probeTimeoutMs?: number;
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
  /** While a half-open probe is in flight, the epoch-ms after which the probe token
   *  self-heals (0 = no probe held). Gates the single-probe admission in {@link tryProbe}
   *  so a cooldown expiry does not stampede the whole fleet onto a just-recovered
   *  upstream. Cleared on the next record{Success,Failure}. */
  probeUntil: number;
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
 * Recovery is single-probed: when the cooldown expires, {@link tryProbe} (called at
 * DISPATCH, not during ordering) admits exactly one caller to test the upstream and
 * sheds the rest until it resolves, so a cooldown expiry does not stampede the whole
 * fleet's accumulated load onto a just-recovered upstream and immediately re-melt it.
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
  private readonly probeTimeoutMs: number;
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
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 10_000;
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

  /**
   * Single-probe admission for the HALF-OPEN window — called at DISPATCH (right
   * before a candidate is actually forwarded to), NOT during candidate ordering.
   * `isOpen` stays a pure, side-effect-free read (it is consulted repeatedly in the
   * hot failover loop and during selection); the state mutation lives here, gated to
   * the one caller that will really contact the target.
   *
   * Returns true (admit) unless the target is in its half-open window — ejected,
   * cooldown just expired, not yet recovered — AND another probe is already in flight.
   * The first caller to reach dispatch in that window claims the probe token and is
   * admitted; concurrent callers are denied so the whole fleet's accumulated load does
   * not stampede a just-recovered upstream and immediately re-melt it. A fully-OPEN
   * target (cooldown still active) is admitted here because the failover loop only
   * reaches dispatch for an open target as a last resort ("a half-open probe beats a
   * hard fail" — never block your last upstream). The token self-heals after
   * `probeTimeoutMs` so a probe that is granted-but-never-dispatched (ordered behind a
   * healthier primary) or that hangs cannot wedge the target half-open forever, and it
   * is cleared as soon as the probe resolves via record{Success,Failure}.
   *
   * The probe token is per-replica: with cross-replica sharing this admits up to one
   * probe PER REPLICA at recovery (not one fleet-wide), which still collapses each
   * replica's herd to a single call — the finding's concern — without a distributed lock.
   */
  tryProbe(key: string): boolean {
    const now = this.now();
    const s = this.state.get(key);
    if (!s) return true; // never seen → healthy
    // Fully open (local or peer cooldown active): last-resort dispatch — do not block.
    if (s.openUntil > now || this.sync.sharedOpenUntil(key) > now) return true;
    // Not recovering (never ejected, or already recovered) → normal dispatch.
    if (s.ejections === 0) return true;
    // Half-open: admit exactly one probe until it resolves or the token self-heals.
    if (s.probeUntil > now) return false;
    s.probeUntil = now + this.probeTimeoutMs;
    return true;
  }

  /** EWMA error rate (0..1) for observability / least-load selection. */
  errorRate(key: string): number {
    return this.state.get(key)?.ewmaError ?? 0;
  }

  private get(key: string): CircuitState {
    let s = this.state.get(key);
    if (!s) {
      s = {
        consecutiveFailures: 0,
        ewmaError: 0,
        samples: 0,
        ejections: 0,
        openUntil: 0,
        probeUntil: 0,
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
    s.probeUntil = 0; // probe resolved → release the half-open token
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
    s.probeUntil = 0; // probe resolved (faulted) → release the token; a re-trip re-opens below

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
