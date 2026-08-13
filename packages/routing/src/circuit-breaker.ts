export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. */
  failureThreshold?: number;
  /** How long the circuit stays open before a half-open retry. */
  cooldownMs?: number;
  now?: () => number;
}

interface CircuitState {
  failures: number;
  openUntil: number;
}

/**
 * Per-target circuit breaker. After `failureThreshold` consecutive failures the
 * target is skipped for `cooldownMs`; after that it becomes half-open (tried
 * once) — a success resets it, another failure re-opens it immediately.
 */
export class CircuitBreaker {
  private readonly state = new Map<string, CircuitState>();
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.now = opts.now ?? ((): number => Date.now());
  }

  isOpen(key: string): boolean {
    const s = this.state.get(key);
    return s ? s.openUntil > this.now() : false;
  }

  recordSuccess(key: string): void {
    this.state.delete(key);
  }

  recordFailure(key: string): void {
    const s = this.state.get(key) ?? { failures: 0, openUntil: 0 };
    s.failures += 1;
    if (s.failures >= this.threshold) s.openUntil = this.now() + this.cooldownMs;
    this.state.set(key, s);
  }
}
