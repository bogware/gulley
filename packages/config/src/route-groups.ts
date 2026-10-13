import { type RouteGroup, routeGroupSchema } from '@gulley/routing';
import type { ConfigDocument, ConfigEntity } from './document';

/**
 * A `routes` entity's `config` IS a route group (`@gulley/routing` `RouteGroup`):
 * `clientPath`, `mode`, `providers` (≥2, in preference order), and the optional
 * `select` / `weights` / `onStatusCodes` / `hedgeDelayMs` / `modelMap`. The entity
 * `name` is the group name. This is the STRICT form — an unknown key (a typo such as
 * `hedgeDelay`) is rejected at plan/apply and at the console write instead of being
 * silently ignored by the gateway; the env `ROUTE_GROUPS` overlay keeps the lenient
 * base schema so an existing deployment's env never starts failing at boot.
 */
export const routeGroupEntitySchema = routeGroupSchema.strict();

/**
 * Legacy = an entity written by the pre-route-group console (`{ strategy | mode,
 * targets[] }`), recognised by the absence of a `clientPath`. The gateway never read
 * that shape, so it is never applied — and it is deliberately NOT a validation error:
 * a deployment whose document carries one keeps applying/exporting unchanged, the
 * gateway skips it and warns once per reconcile, and the console flags it for
 * conversion. New writes must be the route-group shape.
 */
export function isLegacyRouteEntity(entity: ConfigEntity): boolean {
  return entity.config['clientPath'] === undefined;
}

/** A `routes` entity the gateway does not apply, with the human-readable reason. */
export interface SkippedRouteEntity {
  /** `org/workspace/name` — unique in a single-tenant document. */
  name: string;
  reason: string;
}

interface RouteEntityPartition {
  groups: RouteGroup[];
  skipped: SkippedRouteEntity[];
  /** Validation issues for NEW-shape entities only (a legacy entity is never an issue). */
  issues: string[];
}

function formatIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

/** One pass over every workspace's `routes` entities, in document order (a later
 *  group wins its client path when applied, matching `RouteHolder.reindex`). */
function partitionRouteEntities(doc: ConfigDocument): RouteEntityPartition {
  const out: RouteEntityPartition = { groups: [], skipped: [], issues: [] };
  doc.orgs.forEach((org, oi) => {
    org.workspaces.forEach((ws, wi) => {
      // Tolerate a partial fixture/document: an absent collection is simply empty.
      const routes: ConfigEntity[] = Array.isArray(ws.routes) ? ws.routes : [];
      routes.forEach((entity, ri) => {
        const qualified = `${org.name}/${ws.name}/${entity.name}`;
        if (isLegacyRouteEntity(entity)) {
          out.skipped.push({
            name: qualified,
            reason: 'legacy console shape (no clientPath); ignored by the gateway',
          });
          return;
        }
        const parsed = routeGroupEntitySchema.safeParse(entity.config);
        if (!parsed.success) {
          const detail = formatIssues(parsed.error.issues);
          out.issues.push(
            `orgs[${oi}].workspaces[${wi}].routes[${ri}] ("${entity.name}"): not a valid route group — ${detail}`,
          );
          out.skipped.push({ name: qualified, reason: `invalid route group: ${detail}` });
          return;
        }
        // The entity name is the group name (it wins over a `name` inside config).
        out.groups.push({ ...parsed.data, name: entity.name });
      });
    });
  });
  return out;
}

/** Human-readable issues for every `routes` entity that is NOT a valid route group
 *  (empty when valid). Legacy entities (no `clientPath`) are skipped, not reported.
 *  `validateConfigDocument` folds this in so plan/apply reject a malformed group. */
export function validateRouteEntities(doc: ConfigDocument): string[] {
  return partitionRouteEntities(doc).issues;
}

/** The document's route groups — valid entities only, in document order, each
 *  named after its entity. What the gateway folds over the env overlay. */
export function routeGroupsFromDocument(doc: ConfigDocument): RouteGroup[] {
  return partitionRouteEntities(doc).groups;
}

/** The `routes` entities the gateway will NOT apply (legacy shape, or — defensively,
 *  since plan/apply and the console reject them — invalid), for a reconcile warning. */
export function skippedRouteEntities(doc: ConfigDocument): SkippedRouteEntity[] {
  return partitionRouteEntities(doc).skipped;
}
