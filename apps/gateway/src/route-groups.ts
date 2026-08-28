import { allTargets, type RouteTarget, type RoutingStrategy } from '@gulley/routing';
import { z } from 'zod';
import type { ProviderRoute } from './routes/messages';

/**
 * Declarative multi-target routing overlay (M19). The routing library already
 * implements fallback / weighted load-balance / circuit-breaker / outlier ejection
 * / P2C / HRW affinity / hedging — but the route builders only ever emit
 * single-target strategies, so none of it can operate in a real deployment. A
 * `ROUTE_GROUPS` entry combines the single-target routes the builders produced (by
 * provider name, for one client-path family) into ONE multi-target route, turning
 * the whole resilience surface on.
 */
export const routeGroupSchema = z.object({
  /** Client path (or suffix) this group serves, e.g. `/v1/messages`. */
  clientPath: z.string().min(1),
  mode: z.enum(['fallback', 'loadbalance']),
  /** Provider names to combine, in preference order (fallback) — each must be a
   *  configured provider that already serves `clientPath`. */
  providers: z.array(z.string().min(1)).min(2),
  /** Optional per-provider weight for `loadbalance` (defaults to 1). */
  weights: z.record(z.string(), z.number().positive()).optional(),
  /** Fallback only: upstream status codes that trigger failover to the next target. */
  onStatusCodes: z.array(z.number().int()).optional(),
  /** Per-group hedge delay (ms); 0/absent falls back to the global `HEDGE_DELAY_MS`. */
  hedgeDelayMs: z.number().int().nonnegative().optional(),
});
export type RouteGroup = z.infer<typeof routeGroupSchema>;

const routeGroupsSchema = z.array(routeGroupSchema);

/** Parse + validate the `ROUTE_GROUPS` JSON env value (throws on malformed input,
 *  so a bad config fails fast at boot rather than silently routing single-target). */
export function parseRouteGroups(json: string | undefined): RouteGroup[] {
  if (!json || json.trim() === '') return [];
  const parsed = routeGroupsSchema.safeParse(JSON.parse(json));
  if (!parsed.success) throw new Error(`ROUTE_GROUPS is invalid: ${parsed.error.message}`);
  return parsed.data;
}

/**
 * Fold each route group into a multi-target route appended to `routes` (a later
 * route wins its client paths in `RouteHolder.reindex`, so the group shadows the
 * single-target routes for its path family). The group route inherits the template
 * route's extractor / cacheable / guardrails config and overrides only the strategy
 * and hedge delay. A group whose providers resolve to <2 configured targets is
 * skipped (nothing to fail over between).
 */
export function applyRouteGroups(
  routes: ProviderRoute[],
  groups: RouteGroup[],
  hedgeDefaultMs: number,
): ProviderRoute[] {
  if (groups.length === 0) return routes;
  const out = [...routes];
  for (const g of groups) {
    const serves = (r: ProviderRoute): boolean =>
      r.clientPaths.some((p) => p === g.clientPath || p.endsWith(g.clientPath));
    const template = routes.find(serves);
    if (!template) continue; // no configured provider serves this path — skip
    // Collect one target per provider from the routes serving this path.
    const byProvider = new Map<string, RouteTarget>();
    for (const r of routes) {
      if (!serves(r)) continue;
      for (const t of allTargets(r.strategy))
        if (!byProvider.has(t.provider)) byProvider.set(t.provider, t);
    }
    const targets: RouteTarget[] = [];
    for (const name of g.providers) {
      const base = byProvider.get(name);
      if (!base) continue; // provider not configured — drop it from the group
      targets.push({ ...base, weight: g.weights?.[name] ?? base.weight ?? 1 });
    }
    if (targets.length < 2) continue;
    const strategy: RoutingStrategy =
      g.mode === 'loadbalance'
        ? { mode: 'loadbalance', targets }
        : {
            mode: 'fallback',
            targets,
            ...(g.onStatusCodes ? { onStatusCodes: g.onStatusCodes } : {}),
          };
    const hedgeDelayMs = g.hedgeDelayMs ?? (hedgeDefaultMs > 0 ? hedgeDefaultMs : undefined);
    out.push({ ...template, strategy, ...(hedgeDelayMs ? { hedgeDelayMs } : {}) });
  }
  return out;
}
