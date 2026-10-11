import { z } from 'zod';

/**
 * A declarative multi-target route group (M19). The route builders only ever emit
 * single-target strategies (one per configured provider); a route group combines
 * the single-target routes serving one client-path family — by provider name — into
 * ONE `fallback` / `loadbalance` route, which is what turns the routing library's
 * resilience surface (breaker / outlier ejection / P2C / HRW affinity / hedging) on.
 *
 * One shape, two sources: the env `ROUTE_GROUPS` JSON array (parsed in the gateway)
 * and, in DB-config mode, a config document's `routes` entity — its `config` is a
 * route group and its entity `name` is the group name (`@gulley/config`
 * `routeGroupEntitySchema` is the strict form used for those writes).
 */
export const routeGroupSchema = z.object({
  /** Group name. A DB `routes` entity carries its name here when it is folded
   *  into a group; purely descriptive — `applyRouteGroups` ignores it. */
  name: z.string().min(1).optional(),
  /** Client path (or suffix) this group serves, e.g. `/v1/messages`. */
  clientPath: z.string().min(1),
  mode: z.enum(['fallback', 'loadbalance']),
  /** Provider names to combine, in preference order (fallback) — each must be a
   *  configured provider that already serves `clientPath`. */
  providers: z.array(z.string().min(1)).min(2),
  /** loadbalance primary-pick policy: least-load (default) | cheapest | fastest. */
  select: z.enum(['least-load', 'cheapest', 'fastest']).optional(),
  /** Optional per-provider weight for `loadbalance` (defaults to 1). */
  weights: z.record(z.string(), z.number().positive()).optional(),
  /** Fallback only: upstream status codes that trigger failover to the next target. */
  onStatusCodes: z.array(z.number().int()).optional(),
  /** Per-group hedge delay (ms); 0/absent falls back to the global `HEDGE_DELAY_MS`. */
  hedgeDelayMs: z.number().int().nonnegative().optional(),
  /** Same-model ARBITRAGE across providers whose model ids differ: per-provider map of
   *  the client (canonical) model → the id THAT provider expects. e.g.
   *  `{ "bedrock": { "claude-sonnet-4-6": "us.anthropic.claude-sonnet-4-6-v1:0" } }`.
   *  A provider with no entry forwards the client model verbatim (correct for the
   *  native provider). */
  modelMap: z.record(z.string(), z.record(z.string(), z.string())).optional(),
});
export type RouteGroup = z.infer<typeof routeGroupSchema>;

/** The env `ROUTE_GROUPS` value: a JSON array of route groups. */
export const routeGroupListSchema = z.array(routeGroupSchema);
