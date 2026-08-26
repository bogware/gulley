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
    const rules = await this.opts.resolve(scope);
    if (rules.length === 0) return { outcome: ALLOW_NONE, rules };
    try {
      return { outcome: await this.opts.store.reserve(scope, rules, requestId), rules };
    } catch {
      const outcome: RateLimitOutcome = this.failOpen
        ? { allowed: true, decisions: [], limiting: undefined, degraded: true }
        : {
            allowed: false,
            decisions: [],
            limiting: undefined,
            degraded: true,
            retryAfterSeconds: 1,
          };
      return { outcome, rules };
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
    } catch {
      /* best-effort: a lost true-up slightly under-counts, never blocks */
    }
  }
}
