import { type Result, err, ok } from '@gulley/core';
import type { AuthFailure } from './errors';
import { verifyPassword } from './htpasswd';
import type { Principal, Scope } from './principal';

/**
 * HTTP Basic inbound auth (htpasswd-backed). Deterministic and FAIL-CLOSED: only
 * an `Authorization: Basic` header enters this path (the route policy decides
 * whether Basic is enabled), and every miss is an auth failure — never a
 * fall-through to another mode. Each htpasswd user maps to a Scope; a user with
 * no explicit scope falls back to the configured defaults.
 */
export interface BasicUserScope {
  orgId?: string;
  workspaceId?: string;
  allowedProviders?: readonly string[] | '*';
  allowedModels?: readonly string[] | '*';
}

export interface BasicAuthConfig {
  /** htpasswd entries: user → password hash. */
  htpasswd: Map<string, string>;
  /** Per-user scope overrides; users absent here use the defaults below. */
  users?: Map<string, BasicUserScope>;
  defaultOrgId: string;
  defaultWorkspaceId: string;
  defaultAllowedProviders?: readonly string[] | '*';
  defaultAllowedModels?: readonly string[] | '*';
}

/** Parse `Authorization: Basic <base64(user:pass)>` → credentials, or null. */
export function parseBasicHeader(authorization: string | undefined): {
  user: string;
  password: string;
} | null {
  if (!authorization) return null;
  const m = /^basic\s+(.+)$/i.exec(authorization.trim());
  if (!m || !m[1]) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  if (sep < 0) return null;
  return { user: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

/** Resolve a Basic-auth principal from an Authorization header. */
export function resolveBasicPrincipal(
  authorization: string | undefined,
  cfg: BasicAuthConfig,
): Result<Principal, AuthFailure> {
  const creds = parseBasicHeader(authorization);
  if (!creds) return err({ reason: 'malformed_credential' });

  const hash = cfg.htpasswd.get(creds.user);
  if (!hash) return err({ reason: 'unknown_key' });
  if (!verifyPassword(hash, creds.password)) return err({ reason: 'bad_secret' });

  const override = cfg.users?.get(creds.user);
  const scope: Scope = {
    orgId: override?.orgId ?? cfg.defaultOrgId,
    workspaceId: override?.workspaceId ?? cfg.defaultWorkspaceId,
    allowedProviders: override?.allowedProviders ?? cfg.defaultAllowedProviders ?? '*',
    allowedModels: override?.allowedModels ?? cfg.defaultAllowedModels ?? '*',
  };
  return ok({
    kind: 'basic',
    id: `basic:${creds.user}`,
    displayName: creds.user,
    authMode: 'basic',
    scope,
  });
}
