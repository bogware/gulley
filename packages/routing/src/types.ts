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
  /** Operator-declared data-residency region this upstream serves from (e.g.
   *  `us-east-1`, `eu-central-1`). Used to enforce a residency allowlist and to stamp
   *  the served region on the response/audit. Absent = region unknown, which FAILS
   *  CLOSED under an active residency allowlist. */
  region?: string;
  /** Operator-declared Zero-Data-Retention posture for this upstream (the account /
   *  deployment is enrolled so the provider does not retain request/response data).
   *  A `requireZdr` policy routes only to targets flagged `true`, failing closed
   *  otherwise. */
  zdr?: boolean;
  /** Per-target model-id rewrite for same-model cross-provider ARBITRAGE: maps the
   *  client's (canonical) model id to the id THIS upstream expects (e.g. the client's
   *  `claude-sonnet-4-6` → Bedrock's `us.anthropic.claude-sonnet-4-6-v1:0`). Applied to
   *  the outbound body just before this target's dispatch; absent/unmapped models are
   *  forwarded verbatim. Lets a loadbalance/fallback group span providers whose ids
   *  differ for the same logical model. */
  modelMap?: Record<string, string>;
}

/**
 * Recursive-in-spirit routing strategy (Portkey-style). v1 supports the three
 * non-nested modes; nesting and `conditional` land in a later milestone.
 */
/** Primary-pick policy for a `loadbalance` strategy. `least-load` (default) uses
 *  P2C over in-flight counts (or HRW when a session key is set); `cheapest` ranks
 *  by the catalog price of the requested model; `fastest` ranks by the outlier
 *  detector's observed EWMA time-to-first-byte. The rest become the failover order. */
export type LoadBalanceSelect = 'least-load' | 'cheapest' | 'fastest';

export type RoutingStrategy =
  | { mode: 'single'; target: RouteTarget }
  | { mode: 'loadbalance'; targets: RouteTarget[]; select?: LoadBalanceSelect }
  | { mode: 'fallback'; targets: RouteTarget[]; onStatusCodes?: number[] };

export function allTargets(s: RoutingStrategy): RouteTarget[] {
  return s.mode === 'single' ? [s.target] : s.targets;
}
