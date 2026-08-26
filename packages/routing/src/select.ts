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

/** Tracks in-flight request counts per target, for power-of-two-choices
 *  least-load selection. The gateway begins on the serving target and ends in
 *  teardown. */
export class LoadScoreboard {
  private readonly inflight = new Map<string, number>();
  begin(name: string): void {
    this.inflight.set(name, (this.inflight.get(name) ?? 0) + 1);
  }
  end(name: string): void {
    this.inflight.set(name, Math.max(0, (this.inflight.get(name) ?? 0) - 1));
  }
  load(name: string): number {
    return this.inflight.get(name) ?? 0;
  }
}

export interface SelectOptions {
  rand?: () => number;
  /** When present, `loadbalance` sticks a session to a target via weighted
   *  rendezvous hashing (session affinity). */
  sessionKey?: string;
  /** When present (and no sessionKey), `loadbalance` uses power-of-two-choices
   *  least-load for the primary pick. */
  scoreboard?: LoadScoreboard;
}

/** Stable 32-bit FNV-1a hash → a unit float in [0, 1). */
function hashUnit(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}

/** Weighted rendezvous (HRW): deterministic per session key, weight-biased. The
 *  same key always yields the same primary target while it stays healthy. */
export function hrwOrder(targets: RouteTarget[], sessionKey: string): RouteTarget[] {
  return [...targets]
    .map((t) => {
      const w = Math.max(1e-9, t.weight ?? 1);
      const h = Math.max(1e-9, hashUnit(`${sessionKey}:${t.name}`));
      return { t, score: Math.pow(h, 1 / w) };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.t);
}

/** Power-of-two-choices: pick two at random, put the less-loaded first, then the
 *  rest by weight — spreads load without a full sort's herd behavior. */
export function p2cOrder(
  targets: RouteTarget[],
  scoreboard: LoadScoreboard,
  rand: () => number,
): RouteTarget[] {
  if (targets.length <= 1) return targets;
  const a = targets[Math.floor(rand() * targets.length)] as RouteTarget;
  const b = targets[Math.floor(rand() * targets.length)] as RouteTarget;
  const primary = scoreboard.load(a.name) <= scoreboard.load(b.name) ? a : b;
  return [
    primary,
    ...orderByWeight(
      targets.filter((t) => t !== primary),
      rand,
    ),
  ];
}

/**
 * Ordered candidate targets to attempt. Open circuits are skipped; if every
 * target is open we still return them (a half-open attempt beats a hard fail).
 * `fallback` preserves declared order; `loadbalance` sticks a session (HRW), else
 * picks least-loaded (P2C) or by weight — the first is the primary, the rest its
 * failover order.
 */
export function selectCandidates(
  strategy: RoutingStrategy,
  breaker: CircuitBreaker,
  opts: SelectOptions | (() => number) = {},
): RouteTarget[] {
  const o: SelectOptions = typeof opts === 'function' ? { rand: opts } : opts;
  const rand = o.rand ?? Math.random;
  if (strategy.mode === 'single') return [strategy.target];

  const open = strategy.targets.filter((t) => !breaker.isOpen(t.name));
  const pool = open.length > 0 ? open : strategy.targets;
  if (strategy.mode === 'fallback') return pool;

  if (o.sessionKey) return hrwOrder(pool, o.sessionKey);
  if (o.scoreboard) return p2cOrder(pool, o.scoreboard, rand);
  return orderByWeight(pool, rand);
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
