import { err, ok, type Result } from '@gulley/core';
import type { AdminPrincipal } from '@gulley/rbac';
import { createHash, timingSafeEqual } from 'node:crypto';
import { verifyAdminSession } from './admin-session';

export interface AdminAuthFailure {
  reason: string;
}

/** Revocation store for admin sessions (by jti). Postgres-backed in prod. */
export interface AdminSessionStore {
  isActive(jti: string): Promise<boolean>;
  revoke(jti: string): Promise<void>;
}

export class InMemoryAdminSessionStore implements AdminSessionStore {
  private readonly revoked = new Set<string>();
  async isActive(jti: string): Promise<boolean> {
    return !this.revoked.has(jti);
  }
  async revoke(jti: string): Promise<void> {
    this.revoked.add(jti);
  }
}

export interface AdminResolverDeps {
  /** Whether the break-glass bootstrap path is enabled (off by default). */
  bootstrapEnabled: boolean;
  /** sha256(gadm_ token) in hex — the server never stores the raw token. */
  bootstrapTokenSha256?: string | undefined;
  /** Accepted session-signing secrets (current + previous, for rotation). */
  sessionSecrets: readonly string[];
  sessionStore?: AdminSessionStore | undefined;
  maxSessionTtlMs: number;
  now?: number;
}

const BOOTSTRAP_SUBJECT = 'bootstrap-admin';

function ctEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Resolve the control-plane admin identity from a bearer token. Fail-closed and
 * NO fall-through: a `gadm_` token is only the bootstrap path, a `gses_` token is
 * only the session path, anything else is a generic failure. (Data-plane `gk_`
 * keys are rejected here — the control surface is admin-only.)
 */
export async function resolveAdmin(
  bearer: string | undefined,
  deps: AdminResolverDeps,
): Promise<Result<AdminPrincipal, AdminAuthFailure>> {
  const now = deps.now ?? Date.now();
  if (!bearer) return err({ reason: 'missing' });

  if (bearer.startsWith('gadm_')) {
    if (!deps.bootstrapEnabled || !deps.bootstrapTokenSha256) {
      return err({ reason: 'bootstrap-disabled' });
    }
    const presented = createHash('sha256').update(bearer).digest('hex');
    if (!ctEqualHex(presented, deps.bootstrapTokenSha256)) return err({ reason: 'bad-bootstrap' });
    return ok({
      kind: 'admin',
      subject: BOOTSTRAP_SUBJECT,
      displayName: 'bootstrap admin',
      source: 'bootstrap',
      memberships: [{ role: 'owner', orgId: '*' }],
    });
  }

  if (bearer.startsWith('gses_')) {
    const res = verifyAdminSession(deps.sessionSecrets, bearer, {
      now,
      maxTtlMs: deps.maxSessionTtlMs,
    });
    if (!res.ok) return err({ reason: `session-${res.error}` });
    if (deps.sessionStore && !(await deps.sessionStore.isActive(res.value.jti))) {
      return err({ reason: 'session-revoked' });
    }
    return ok(res.value.principal);
  }

  return err({ reason: 'unknown-scheme' });
}
