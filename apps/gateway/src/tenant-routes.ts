import type { UsageExtractor } from '@gulley/providers';
import type { RoutingStrategy } from '@gulley/routing';

/**
 * A per-tenant routing override. The route table is shared by default; a tenant
 * (workspace) may override the strategy for a client path — e.g. tenant A's
 * `/v1/messages` serves Anthropic while tenant B's serves a self-hosted model.
 * When the override reroutes to a different provider FAMILY, it must carry the
 * matching `createExtractor` so metering reads that provider's usage; omit it to
 * keep the base route's extractor (same-family override).
 */
export interface TenantRoute {
  strategy: RoutingStrategy;
  createExtractor?: () => UsageExtractor;
}

/**
 * Resolves a per-tenant route override for a workspace, or undefined to fall back
 * to the shared route. It is passed ALL of the matched route's client-path aliases
 * (a single route is indexed under each of `clientPaths`), and must return an
 * override configured under ANY of them — otherwise an override keyed under one
 * alias would be silently ignored when the client hits a sibling alias, letting a
 * tenant escape its own routing pin (a data-residency/isolation bypass). Keep it
 * synchronous + hot-path: back a DB-driven implementation with an in-memory
 * snapshot, like the breaker-sync snapshot.
 */
export interface TenantRouteResolver {
  resolve(workspaceId: string, clientPaths: readonly string[]): TenantRoute | undefined;
}

/** In-process tenant routes (dev/tests): workspaceId → clientPath → override.
 *  An override keyed under any one of the route's aliases applies to them all. */
export class MapTenantRouteResolver implements TenantRouteResolver {
  constructor(private readonly map: ReadonlyMap<string, ReadonlyMap<string, TenantRoute>>) {}
  resolve(workspaceId: string, clientPaths: readonly string[]): TenantRoute | undefined {
    const byPath = this.map.get(workspaceId);
    if (!byPath) return undefined;
    for (const path of clientPaths) {
      const hit = byPath.get(path);
      if (hit) return hit;
    }
    return undefined;
  }
}
