import type { RateLimit, RateLimitOutcome, RateLimitStore, RuleDecision } from './types';
import { finalizeOutcome, resetSecondsUntil, windowFor } from './util';

interface Counter {
  count: number;
  resetMs: number;
}

/**
 * In-process fixed-window limiter — for dev/CI and single-replica deployments.
 * Naturally atomic (single-threaded event loop). On multi-task Fargate this
 * under-counts by up to N×, so production uses the Redis store; this is the
 * fail-open-friendly default when no Redis counters URL is configured.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly cells = new Map<string, Counter>();

  constructor(private readonly now: () => number = Date.now) {}

  private cell(scope: string, rule: RateLimit, nowMs: number): Counter {
    const { start, resetMs } = windowFor(nowMs, rule.windowSeconds);
    const key = `${scope}|${rule.id}|${start}`;
    let c = this.cells.get(key);
    if (!c || nowMs >= c.resetMs) {
      c = { count: 0, resetMs };
      this.cells.set(key, c);
      this.sweep(nowMs);
    }
    return c;
  }

  /** Drop expired counters so the map cannot grow without bound. */
  private sweep(nowMs: number): void {
    if (this.cells.size < 1024) return;
    for (const [k, v] of this.cells) if (nowMs >= v.resetMs) this.cells.delete(k);
  }

  async reserve(scope: string, rules: RateLimit[], _requestId: string): Promise<RateLimitOutcome> {
    const nowMs = this.now();
    const cells = rules.map((rule) => this.cell(scope, rule, nowMs));

    // Pass 1: check every rule without mutating.
    const oks = rules.map((rule, i) => {
      const c = cells[i] as Counter;
      return rule.unit === 'requests' ? c.count + 1 <= rule.limit : c.count < rule.limit;
    });
    const allowed = oks.every(Boolean);

    // Pass 2: only when all rules pass do we consume request-rate.
    const decisions: RuleDecision[] = rules.map((rule, i) => {
      const c = cells[i] as Counter;
      if (allowed && rule.unit === 'requests') c.count += 1;
      return {
        rule,
        allowed: oks[i] as boolean,
        used: c.count,
        remaining: Math.max(0, rule.limit - c.count),
        resetSeconds: resetSecondsUntil(nowMs, c.resetMs),
      };
    });
    return finalizeOutcome(decisions);
  }

  async commit(
    scope: string,
    rules: RateLimit[],
    _requestId: string,
    actualTokens: number,
  ): Promise<void> {
    if (actualTokens <= 0) return;
    const nowMs = this.now();
    for (const rule of rules) {
      if (rule.unit !== 'tokens') continue;
      this.cell(scope, rule, nowMs).count += actualTokens;
    }
  }
}
