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
  defaultWorkspaceId?: string;
  defaultOrgId?: string;
}

export function looksLikeJwt(token: string): boolean {
  return token.startsWith('eyJ') && token.split('.').length === 3;
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

/** Resolve a Principal from a verified inbound JWT, or null when the token is
 *  invalid or carries no resolvable scope (deny-by-default). */
export async function resolveJwtPrincipal(
  bearer: string,
  cfg: JwtAuthConfig,
): Promise<Principal | null> {
  const res = await cfg.provider.verify(bearer, { audience: cfg.audience });
  if (!res.ok) return null;
  const c = res.claims as Record<string, unknown>;
  const workspaceId = str(c[cfg.workspaceClaim]) ?? cfg.defaultWorkspaceId;
  const orgId = str(c[cfg.orgClaim]) ?? cfg.defaultOrgId;
  if (!workspaceId || !orgId) return null; // can't scope the request → deny
  const scope: Scope = {
    orgId,
    workspaceId,
    allowedProviders: listClaim(c, cfg.providersClaim) ?? '*',
    allowedModels: listClaim(c, cfg.modelsClaim) ?? '*',
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
