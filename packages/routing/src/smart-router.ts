/**
 * Smart routing — the declarative policy model and the selector-precedence
 * resolver (M15). This module is pure and serializable: `categoryRoutes` maps a
 * classified category to a route *reference* (a name resolved to a live strategy
 * by the gateway config-builder), so nothing here holds live adapter/credential
 * objects. The classifier ENGINE (which turns a prompt into a category) is added
 * to this package in a later phase; here we only decide WHICH policy applies to a
 * request and hold its declarative shape.
 */

export type ClassifierMode = 'embedding-nearest-label' | 'llm-router' | 'rules-then-llm';

export type SmartRoutingObjective =
  'cost-tier' | 'domain-skill' | 'safety-risk' | 'operator-taxonomy';

/** A single `rules-then-llm` rule: assign `category` when the prompt matches. */
export interface ClassifierRule {
  category: string;
  /** Any of these substrings (case-insensitive) present ⇒ match. */
  anyOf?: readonly string[];
  /** RE2-safe regex source; a match ⇒ this category (compiled by the engine). */
  regex?: string;
  /** Prompt length ≤ this many chars ⇒ match (e.g. a "short/simple" tier). */
  maxChars?: number;
}

/** How a policy classifies a request into a category. */
export interface ClassifierSpec {
  mode: ClassifierMode;
  /** `embedding-nearest-label`: the declared taxonomy labels. Reserved for the
   *  embedding-backend follow-on; the current engine scopes the centroid lookup
   *  by the policy name and does not read this field yet. */
  labels?: readonly string[];
  /** `rules-then-llm`: ordered rules; first match wins, else escalate to the model. */
  rules?: readonly ClassifierRule[];
  /** `llm-router` / rules escalation: the model id that returns a category label. */
  model?: string;
  /** Provider kind whose resolved credential the classifier call reuses. */
  providerRef?: string;
  /** Classifier timeout (ms); on expiry the request falls back to the model router. */
  timeoutMs?: number;
  /** Meter the classifier's own LLM/embedding spend against the tenant budget. */
  meterClassifier?: boolean;
}

/**
 * Which principals/paths a policy applies to. An unset field is a wildcard; a
 * policy matches a request when every SET field matches. Precedence among
 * matching policies is by the most-specific pinned axis
 * (user > group > route > workspace > org), then `priority`.
 */
export interface SmartSelector {
  /** `principal.id` (the JWT `sub` / Basic user / virtual-key id). */
  user?: string;
  /** One of the principal's `scope.groups`. */
  group?: string;
  /** `scope.orgId`. */
  org?: string;
  /** `scope.workspaceId` (the tenant). */
  workspace?: string;
  /** One of the matched route's `clientPaths`. */
  route?: string;
}

/**
 * A declarative smart-routing policy. `TRoute` is the route-reference type — a
 * plain `string` name in config, resolved to a live strategy by the gateway.
 */
export interface SmartRoutingPolicy<TRoute = string> {
  name: string;
  /** Advisory operator metadata — what the policy is FOR. Recorded (not branched
   *  on): the engine keys entirely off `classifier.mode`. */
  objective: SmartRoutingObjective;
  classifier: ClassifierSpec;
  categoryRoutes: Readonly<Record<string, TRoute>>;
  /**
   * Category to use when the classifier abstains or returns an unknown label;
   * absent ⇒ fall back to the model router (fail-open).
   */
  defaultCategory?: string;
  selector: SmartSelector;
  /** Tie-break among equally-specific matches (higher wins; default 0). */
  priority?: number;
}

/** The request identity a policy is resolved against. */
export interface SmartRoutingIdentity {
  userId: string;
  groups: readonly string[];
  orgId: string;
  workspaceId: string;
  clientPaths: readonly string[];
}

export interface SmartRouteResolver<TRoute = string> {
  resolve(identity: SmartRoutingIdentity): SmartRoutingPolicy<TRoute> | undefined;
}

// Precedence weights: each axis strictly dominates all lower axes combined
// (16 > 8+4+2+1), so specificity is decided by the highest pinned axis, and
// pinning more axes is more specific — a total order matching
// user > group > route > workspace > org.
const AXIS_WEIGHT = { user: 16, group: 8, route: 4, workspace: 2, org: 1 } as const;

function selectorMatches(sel: SmartSelector, id: SmartRoutingIdentity): boolean {
  if (sel.user !== undefined && sel.user !== id.userId) return false;
  if (sel.group !== undefined && !id.groups.includes(sel.group)) return false;
  if (sel.org !== undefined && sel.org !== id.orgId) return false;
  if (sel.workspace !== undefined && sel.workspace !== id.workspaceId) return false;
  if (sel.route !== undefined && !id.clientPaths.includes(sel.route)) return false;
  return true;
}

/** Specificity score — the higher, the more specific (see {@link AXIS_WEIGHT}). */
export function selectorSpecificity(sel: SmartSelector): number {
  let s = 0;
  if (sel.user !== undefined) s += AXIS_WEIGHT.user;
  if (sel.group !== undefined) s += AXIS_WEIGHT.group;
  if (sel.route !== undefined) s += AXIS_WEIGHT.route;
  if (sel.workspace !== undefined) s += AXIS_WEIGHT.workspace;
  if (sel.org !== undefined) s += AXIS_WEIGHT.org;
  return s;
}

/**
 * In-process resolver (dev/tests + the snapshot behind a DB-driven one). Pre-sorts
 * policies by (specificity desc, priority desc, name asc) so `resolve` returns the
 * first match — deterministic and O(n) per request over the policy list.
 */
export class MapSmartRouteResolver<TRoute = string> implements SmartRouteResolver<TRoute> {
  private readonly policies: readonly SmartRoutingPolicy<TRoute>[];

  constructor(policies: readonly SmartRoutingPolicy<TRoute>[]) {
    this.policies = [...policies].sort((a, b) => {
      const sa = selectorSpecificity(a.selector);
      const sb = selectorSpecificity(b.selector);
      if (sa !== sb) return sb - sa;
      const pa = a.priority ?? 0;
      const pb = b.priority ?? 0;
      if (pa !== pb) return pb - pa;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
  }

  resolve(identity: SmartRoutingIdentity): SmartRoutingPolicy<TRoute> | undefined {
    for (const p of this.policies) {
      if (selectorMatches(p.selector, identity)) return p;
    }
    return undefined;
  }
}
