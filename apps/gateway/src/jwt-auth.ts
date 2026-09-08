import type { Principal, Scope } from '@gulley/auth';
import type { OidcProvider } from '@gulley/oidc';

/**
 * Inbound JWT auth mode: verify a client's IdP-issued JWT (JWKS, iss/aud) and map
 * its claims to a Principal + Scope, so a gateway can be fronted by the client's
 * own IdP instead of (or alongside) virtual keys. Selected deterministically —
 * only a bearer that looks like a JWT enters this path; the reserved virtual-key
 * prefix keeps the two channels non-overlapping (no fall-through).
 */
export interface JwtAuthConfig {
  provider: OidcProvider;
  audience: string | string[];
  /** Claim carrying the workspace id (falls back to defaultWorkspaceId). */
  workspaceClaim: string;
  /** Claim carrying the org id (falls back to defaultOrgId). */
  orgClaim: string;
  /** Claim listing allowed model ids (array or space/comma string); absent ⇒ '*'. */
  modelsClaim?: string;
  /** Claim listing allowed provider kinds; absent ⇒ '*'. */
  providersClaim?: string;
  /** Claim listing the caller's group/team tags (for per-group config); absent ⇒ none. */
  groupsClaim?: string;
  /**
   * Entra group/App-Role → scope allowlist. When set (non-empty), a caller's
   * group/role values (Entra App Roles, the configured groups claim, and raw
   * `groups`) must match at least one rule OR carry an explicit workspace claim,
   * else the request is DENIED — so mere token validity never grants access. A
   * matching rule supplies org/workspace and (optionally) narrows models/providers.
   */
  groupScopeRules?: readonly JwtGroupScopeRule[];
  defaultWorkspaceId?: string;
  defaultOrgId?: string;
}

/** Maps one Entra group or App Role to a data-plane scope. */
export interface JwtGroupScopeRule {
  group: string;
  orgId: string;
  workspaceId: string;
  /** Allowed model ids for this group; omitted ⇒ no model restriction from this rule. */
  models?: readonly string[];
  /** Allowed provider kinds for this group; omitted ⇒ no provider restriction. */
  providers?: readonly string[];
}

export function looksLikeJwt(token: string): boolean {
  return token.startsWith('eyJ') && token.split('.').length === 3;
}

/** Parse JWT_GROUP_SCOPE_MAP (JSON array). Invalid entries are dropped, not fatal. */
export function parseGroupScopeMap(json: string): JwtGroupScopeRule[] {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter(
    (r): r is JwtGroupScopeRule =>
      !!r &&
      typeof (r as JwtGroupScopeRule).group === 'string' &&
      typeof (r as JwtGroupScopeRule).orgId === 'string' &&
      typeof (r as JwtGroupScopeRule).workspaceId === 'string',
  );
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function listClaim(
  claims: Record<string, unknown>,
  name: string | undefined,
): readonly string[] | undefined {
  if (!name) return undefined;
  const v = claims[name];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return v.split(/[\s,]+/).filter(Boolean);
  return undefined;
}

/** The caller's group/role identity values: Entra App Roles (`roles`, primary) ∪ the
 *  configured groups claim ∪ raw `groups`, deduped. */
function callerGroups(c: Record<string, unknown>, groupsClaim: string | undefined): string[] {
  const out = new Set<string>();
  for (const key of ['roles', groupsClaim, 'groups']) {
    for (const g of listClaim(c, key) ?? []) out.add(g);
  }
  return [...out];
}

/** Merge the per-rule allow-lists for the chosen workspace: any rule with NO
 *  restriction widens to '*'; otherwise the union of the listed values. Returns
 *  undefined when there are no rules to merge (caller falls back to its default). */
function mergeAllow(lists: ReadonlyArray<readonly string[] | undefined>): readonly string[] | '*' | undefined {
  if (lists.length === 0) return undefined;
  if (lists.some((l) => l === undefined)) return '*';
  const out = new Set<string>();
  for (const l of lists) for (const v of l ?? []) out.add(v);
  return [...out];
}

/** Resolve a Principal from a verified inbound JWT, or null when the token is
 *  invalid or carries no resolvable scope (deny-by-default). */
export async function resolveJwtPrincipal(
  bearer: string,
  cfg: JwtAuthConfig,
): Promise<Principal | null> {
  const res = await cfg.provider.verify(bearer, { audience: cfg.audience });
  if (!res.ok) return null;
  const c = res.claims as Record<string, unknown>;

  const wsFromClaim = str(c[cfg.workspaceClaim]);
  const groups = callerGroups(c, cfg.groupsClaim);
  const rules = cfg.groupScopeRules ?? [];
  const matched = rules.filter((r) => groups.includes(r.group));

  // A configured group→scope allowlist is authoritative: with no matching rule and
  // no explicit workspace claim, deny — token validity alone must not authorize.
  if (rules.length > 0 && matched.length === 0 && !wsFromClaim) return null;

  const workspaceId = wsFromClaim ?? matched[0]?.workspaceId ?? cfg.defaultWorkspaceId;
  const orgId = str(c[cfg.orgClaim]) ?? matched[0]?.orgId ?? cfg.defaultOrgId;
  if (!workspaceId || !orgId) return null; // can't scope the request → deny

  // Narrow models/providers by the rules that target the CHOSEN workspace (a rule for
  // a different workspace must not widen this one).
  const rulesForWs = matched.filter((r) => r.workspaceId === workspaceId);
  const allowedModels =
    listClaim(c, cfg.modelsClaim) ?? mergeAllow(rulesForWs.map((r) => r.models)) ?? '*';
  const allowedProviders =
    listClaim(c, cfg.providersClaim) ?? mergeAllow(rulesForWs.map((r) => r.providers)) ?? '*';

  const scope: Scope = {
    orgId,
    workspaceId,
    allowedProviders,
    allowedModels,
    // The scope.groups TAG follows the configured groups claim (unchanged); rule
    // matching above uses the broader App-Role ∪ groups set.
    groups: listClaim(c, cfg.groupsClaim),
  };
  const sub = str(c['sub']) ?? 'jwt';
  return {
    kind: 'oauth-broker',
    id: sub,
    displayName: str(c['name']) ?? str(c['preferred_username']) ?? sub,
    authMode: 'oauth-broker',
    scope,
  };
}
