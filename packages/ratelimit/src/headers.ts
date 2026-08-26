import type { RateLimitOutcome } from './types';

/**
 * Standard `x-ratelimit-*` response headers derived from the binding rule (the
 * most-constrained one), plus `retry-after` when the request was rejected.
 * Returns an empty object when no rule applied.
 */
export function rateLimitHeaders(outcome: RateLimitOutcome): Record<string, string> {
  const l = outcome.limiting;
  if (!l) return {};
  const headers: Record<string, string> = {
    'x-ratelimit-limit': String(l.rule.limit),
    'x-ratelimit-remaining': String(l.remaining),
    'x-ratelimit-reset': String(l.resetSeconds),
  };
  if (!outcome.allowed && outcome.retryAfterSeconds != null) {
    headers['retry-after'] = String(outcome.retryAfterSeconds);
  }
  return headers;
}
