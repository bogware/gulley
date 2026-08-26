import type { RateLimitOutcome, RuleDecision } from './types';

export interface FixedWindow {
  /** Epoch-ms at the window start (aligned to windowSeconds). */
  start: number;
  /** Epoch-ms at which the window resets. */
  resetMs: number;
}

/** The epoch-aligned fixed window containing `nowMs`. */
export function windowFor(nowMs: number, windowSeconds: number): FixedWindow {
  const w = windowSeconds * 1000;
  const start = Math.floor(nowMs / w) * w;
  return { start, resetMs: start + w };
}

/** Whole seconds from `nowMs` until `resetMs` (never negative). */
export function resetSecondsUntil(nowMs: number, resetMs: number): number {
  return Math.max(0, Math.ceil((resetMs - nowMs) / 1000));
}

/**
 * Assemble the final outcome from per-rule decisions: the binding rule is the
 * one that rejected (if any) or, when all passed, the one with the least
 * headroom — that is what the `x-ratelimit-*` headers should reflect.
 */
export function finalizeOutcome(decisions: RuleDecision[]): RateLimitOutcome {
  const allowed = decisions.every((d) => d.allowed);
  let limiting: RuleDecision | undefined;
  if (!allowed) {
    limiting = decisions.find((d) => !d.allowed);
  } else {
    for (const d of decisions) {
      if (!limiting || d.remaining < limiting.remaining) limiting = d;
    }
  }
  return {
    allowed,
    decisions,
    limiting,
    retryAfterSeconds: allowed ? undefined : limiting?.resetSeconds,
  };
}
