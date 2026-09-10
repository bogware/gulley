import { resolveAdmin } from '@gulley/auth';
import { type AdminPrincipal, coversWorkspace, type Permission, type ScopeRef } from '@gulley/rbac';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ControlContext } from './context';
import { parseCookies, SESSION_COOKIE } from './oidc-gate';

/** Workspace ids the principal is actually allowed to see (org-wide membership →
 *  all workspaces in that org; workspace-scoped → only that workspace). */
export function visibleWorkspaceIds(ctx: ControlContext, admin: AdminPrincipal): Set<string> {
  return new Set(
    ctx.workspaces
      .list('*')
      .filter((w) => coversWorkspace(admin, w.orgId, w.id))
      .map((w) => w.id),
  );
}

export function bearerToken(request: FastifyRequest): string | undefined {
  const raw = request.headers['authorization'];
  const auth = Array.isArray(raw) ? raw[0] : raw;
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return undefined;
}

/** The admin token from either the Authorization bearer or the OIDC session cookie. */
export function sessionToken(request: FastifyRequest): string | undefined {
  return bearerToken(request) ?? parseCookies(request.headers.cookie)[SESSION_COOKIE];
}

type AdminHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
  admin: AdminPrincipal,
) => Promise<unknown>;

/** Wrap a handler so it only runs for a resolved admin identity; a generic 401
 *  otherwise (the control surface never falls through to another auth mode). */
export function adminRoute(ctx: ControlContext, handler: AdminHandler) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const res = await resolveAdmin(sessionToken(request), ctx.resolverDeps);
    if (!res.ok) {
      return reply
        .code(401)
        .send({ error: { type: 'authentication_error', message: 'invalid credentials' } });
    }
    return handler(request, reply, res.value);
  };
}

export interface AuditedWriteArgs<T> {
  perm: Permission;
  at: ScopeRef;
  action: string;
  target: string;
  diff: Record<string, unknown>;
  mutate: () => T | Promise<T>;
}

/**
 * Permission-check (deny by default) → mutate → append a hash-chained audit row.
 *
 * NOT atomic: `mutate` targets the in-memory registries (OrgStore/WorkspaceStore/…), which
 * are not Drizzle operations, so the mutation and the audit append cannot share one
 * transaction here. If `append` throws AFTER `mutate` has run, the change is applied with
 * no audit row and the throw surfaces as a 500 (a retry can then duplicate the mutation).
 * The durable, genuinely-atomic governance path is `configAtomic` (context.ts), which wraps
 * tx-bound Postgres stores + a tx-bound PostgresAuditSink in one db.transaction — the
 * config-apply route uses it. Making auditedWrite itself atomic requires first making these
 * stores tx-aware Postgres stores (tracked as a follow-up); this comment previously claimed
 * a one-tx Postgres path that does not exist.
 */
export async function auditedWrite<T>(
  ctx: ControlContext,
  admin: AdminPrincipal,
  args: AuditedWriteArgs<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  if (!(await ctx.access.can(admin, args.perm, args.at))) return { ok: false };
  const value = await args.mutate();
  await ctx.audit.append({
    orgId: args.at.orgId ?? null,
    actor: admin.subject,
    action: args.action,
    target: args.target,
    payload: args.diff,
  });
  return { ok: true, value };
}

export function forbidden(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({ error: { type: 'permission_error', message: 'forbidden' } });
}

export function notFound(reply: FastifyReply, what: string): FastifyReply {
  return reply.code(404).send({ error: { type: 'not_found', message: `${what} not found` } });
}

/** Resolve the scope of a workspace from the parent chain (never the request
 *  body), so a caller cannot forge an orgId to escape RBAC. */
export function scopeForWorkspace(ctx: ControlContext, workspaceId: string): ScopeRef | undefined {
  const ws = ctx.workspaces.get(workspaceId);
  if (!ws) return undefined;
  return { orgId: ws.orgId, workspaceId: ws.id };
}

export function scopeForProvider(ctx: ControlContext, providerId: string): ScopeRef | undefined {
  const provider = ctx.providers.get(providerId);
  if (!provider) return undefined;
  return scopeForWorkspace(ctx, provider.workspaceId);
}

export function body(request: FastifyRequest): Record<string, unknown> {
  return (request.body ?? {}) as Record<string, unknown>;
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
