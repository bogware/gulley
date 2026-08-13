import type { ProviderAdapter, UpstreamCredential } from '@gulley/providers';

/** One concrete upstream a route can send to. */
export interface RouteTarget {
  /** Stable key for circuit-breaker state + logging. */
  name: string;
  /** Provider label used for metering/pricing/scope. */
  provider: string;
  adapter: ProviderAdapter;
  credential: UpstreamCredential;
  upstreamPath: string;
  alwaysStream?: boolean;
  /** Relative weight for load-balancing (default 1). */
  weight?: number;
}

/**
 * Recursive-in-spirit routing strategy (Portkey-style). v1 supports the three
 * non-nested modes; nesting and `conditional` land in a later milestone.
 */
export type RoutingStrategy =
  | { mode: 'single'; target: RouteTarget }
  | { mode: 'loadbalance'; targets: RouteTarget[] }
  | { mode: 'fallback'; targets: RouteTarget[]; onStatusCodes?: number[] };

export function allTargets(s: RoutingStrategy): RouteTarget[] {
  return s.mode === 'single' ? [s.target] : s.targets;
}
