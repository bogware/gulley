import type { RateLimit, RateLimitOutcome, RateLimitStore, RuleResolver } from './types';

const ALLOW_NONE: RateLimitOutcome = { allowed: true, decisions: [], limiting: undefined };

export interface RateLimiterOptions {
  store: RateLimitStore;
  /** Resolve the rules for a scope (empty ⇒ no limiting). */
  resolve: RuleResolver;
  /**
   * What to do when the limiter dependency (Redis) errors. `true` (default)
   * admits the request — availability over strictness, matching how the cache
   * fails open; `false` rejects, for deployments that treat the limiter as a
   * hard control.
   */
  failOpen?: boolean;
  /** Observability hook for a store/resolver failure (the degraded path). The limiter
   *  itself stays silent so a transient outage cannot log per request; the host
   *  throttles/meters. `stage` says which dependency failed. */
  onError?: (err: unknown, stage: 'resolve' | 'reserve' | 'commit') => void;
}

/**
 * Orchestrates rule resolution + the store, and degrades deterministically when
 * the backend is unavailable. `check` runs at admission; `commit` trues up token
 * rules from the metered response — call it in the request teardown so a failed
 * true-up never blocks the client.
 */
export class RateLimiter {
  private readonly failOpen: boolean;

  constructor(private readonly opts: RateLimiterOptions) {
    this.failOpen = opts.failOpen ?? true;
  }

  async check(
    scope: string,
    requestId: string,
  ): Promise<{ outcome: RateLimitOutcome; rules: RateLimit[] }> {
    // The rule lookup is a dependency too (Postgres): a failure there must degrade
    // per the same policy as a store failure, not escape as an unhandled 500.
    let rules: RateLimit[];
    try {
      rules = await this.opts.resolve(scope);
    } catch (err) {
      this.opts.onError?.(err, 'resolve');
      return { outcome: this.degraded(), rules: [] };
    }
    if (rules.length === 0) return { outcome: ALLOW_NONE, rules };
    try {
      return { outcome: await this.opts.store.reserve(scope, rules, requestId), rules };
    } catch (err) {
      this.opts.onError?.(err, 'reserve');
      return { outcome: this.degraded(), rules };
    }
  }

  private degraded(): RateLimitOutcome {
    {
      const outcome: RateLimitOutcome = this.failOpen
        ? { allowed: true, decisions: [], limiting: undefined, degraded: true }
        : {
            allowed: false,
            decisions: [],
            limiting: undefined,
            degraded: true,
            retryAfterSeconds: 1,
          };
      return outcome;
    }
  }

  async commit(
    scope: string,
    rules: RateLimit[],
    requestId: string,
    actualTokens: number,
  ): Promise<void> {
    if (!rules.some((r) => r.unit === 'tokens')) return;
    try {
      await this.opts.store.commit(scope, rules, requestId, actualTokens);
    } catch (err) {
      /* best-effort: a lost true-up slightly under-counts, never blocks */
      this.opts.onError?.(err, 'commit');
    }
  }
}
