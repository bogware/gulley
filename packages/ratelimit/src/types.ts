/**
 * Rate limiting — RPM (requests) and TPM (tokens) fixed-window limits, the
 * request-rate counterpart to `@gulley/budget` (which caps USD). A limit is
 * evaluated at admission; request-rate is known then (charge 1), while
 * token-rate is metered post-response, so tokens are checked at admission
 * (reject if the window is already exhausted) and their actual count is added at
 * commit — the same reserve/true-up shape budgets use. Windows are epoch-aligned
 * fixed windows so every replica agrees on the boundary without coordination.
 */
export type RateLimitUnit = 'requests' | 'tokens';

export interface RateLimit {
  /** Stable id (per scope) so a rule's counter is addressable across replicas. */
  id: string;
  /** Max units permitted per window. */
  limit: number;
  /** Fixed-window length in seconds. */
  windowSeconds: number;
  unit: RateLimitUnit;
}

export interface RuleDecision {
  rule: RateLimit;
  /** Did THIS rule permit the request? */
  allowed: boolean;
  /** Units consumed in the current window (including this request for request rules). */
  used: number;
  /** max(0, limit - used). */
  remaining: number;
  /** Seconds until the current window resets. */
  resetSeconds: number;
}

export interface RateLimitOutcome {
  /** True only if EVERY rule permitted the request. */
  allowed: boolean;
  decisions: RuleDecision[];
  /** The binding (most-constrained) rule, for `x-ratelimit-*` response headers. */
  limiting: RuleDecision | undefined;
  /** Set when rejected: seconds the client should wait. */
  retryAfterSeconds?: number;
  /** True when the limiter dependency failed and the outcome is a fail-open/closed fallback. */
  degraded?: boolean;
}

/**
 * A rate-limit backend. `reserve` atomically evaluates all rules for a scope
 * (all-or-nothing on the request-rate increments); `commit` adds the actual
 * token count to token-rule windows after the response is metered.
 */
export interface RateLimitStore {
  reserve(scope: string, rules: RateLimit[], requestId: string): Promise<RateLimitOutcome>;
  commit(scope: string, rules: RateLimit[], requestId: string, actualTokens: number): Promise<void>;
}

/** Resolve the active rules for a scope (workspace / principal / virtual key). */
export type RuleResolver = (scope: string) => RateLimit[] | Promise<RateLimit[]>;
