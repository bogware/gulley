import type { CircuitBreaker } from './circuit-breaker';
import type { RouteTarget, RoutingStrategy } from './types';

/** Retryable/failover-worthy upstream statuses (transient + overload). Terminal
 *  4xx (e.g. 400/401/403/404) are NOT here — they don't fail over. */
export const DEFAULT_FAILOVER_STATUS = [408, 409, 429, 500, 502, 503, 504, 529];

export function isFailoverStatus(strategy: RoutingStrategy, code: number): boolean {
  const codes =
    strategy.mode === 'fallback' && strategy.onStatusCodes
      ? strategy.onStatusCodes
      : DEFAULT_FAILOVER_STATUS;
  return codes.includes(code);
}

/**
 * Ordered candidate targets to attempt. Open circuits are skipped; if every
 * target is open we still return them (a half-open attempt beats a hard fail).
 * `fallback` preserves declared order; `loadbalance` picks by weight (the first
 * is the primary pick, the rest are its failover order).
 */
export function selectCandidates(
  strategy: RoutingStrategy,
  breaker: CircuitBreaker,
  rand: () => number = Math.random,
): RouteTarget[] {
  if (strategy.mode === 'single') return [strategy.target];

  const open = strategy.targets.filter((t) => !breaker.isOpen(t.name));
  const pool = open.length > 0 ? open : strategy.targets;

  return strategy.mode === 'fallback' ? pool : orderByWeight(pool, rand);
}

/** Weighted shuffle: each position drawn by weight from the remainder. */
export function orderByWeight(targets: RouteTarget[], rand: () => number): RouteTarget[] {
  const remaining = [...targets];
  const out: RouteTarget[] = [];
  while (remaining.length > 0) {
    const total = remaining.reduce((sum, t) => sum + (t.weight ?? 1), 0);
    let r = rand() * total;
    let idx = 0;
    for (let i = 0; i < remaining.length; i++) {
      r -= remaining[i]?.weight ?? 1;
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    out.push(remaining.splice(idx, 1)[0] as RouteTarget);
  }
  return out;
}
