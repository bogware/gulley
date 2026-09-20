import type { FastifyInstance } from 'fastify';

import { adminRoute, body, forbidden, notFound, str, strMax } from './admin';
import type { ControlContext } from './context';

/** The grant types the broker implements (see /.well-known/oauth-authorization-server). */
const GRANT_TYPES = new Set(['device_code', 'authorization_code', 'refresh_token']);

/** A redirect allowlist entry: an absolute http(s) URL, or a loopback path template. */
function validRedirectEntry(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 2_048) return false;
  if (v.startsWith('/')) return true; // loopback path (the CLI's dynamic-port redirect)
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * OAuth / Enterprise identity MANAGEMENT surface for the console (distinct from the
 * broker's own /oauth/* protocol endpoints): list + revoke live admin sessions, the
 * OAuth client registry (CRUD), issued broker grants (list + revoke), pending device
 * authorizations, and the refresh-token-reuse (theft) feed derived from the audit log.
 *
 * The grant/client/device views need the durable stores (DB mode) — 501 otherwise. All
 * gate at the empty deployment scope (platform-wide membership), since OAuth objects are
 * fleet-global, not workspace-scoped.
 */
export function registerOAuthAdminRoutes(app: FastifyInstance, ctx: ControlContext): void {
  const noDb = { error: { type: 'not_configured', message: 'OAuth admin requires a database' } };

  // --- admin sessions ---
  app.get(
    '/admin/sessions',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'membership:read', {}))) return forbidden(reply);
      if (!ctx.sessions.list) return reply.send({ sessions: [], enumerable: false });
      return reply.send({ sessions: await ctx.sessions.list(), enumerable: true });
    }),
  );

  app.delete(
    '/admin/sessions/:jti',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!(await ctx.access.can(admin, 'membership:delete', {}))) return forbidden(reply);
      const jti = (request.params as { jti: string }).jti;
      // jti is a uuid column in the durable registry — reject a malformed id (a raw cast
      // would 500 and insert a placeholder revoked row for an arbitrary string).
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jti)) {
        return notFound(reply, 'session');
      }
      await ctx.sessions.revoke(jti);
      await ctx.audit.append({
        orgId: null,
        actor: admin.subject,
        action: 'admin.session.revoke',
        target: jti,
        payload: { jti },
      });
      return reply.send({ revoked: true });
    }),
  );

  // --- OAuth client registry ---
  app.get(
    '/admin/oauth/clients',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'key:read', {}))) return forbidden(reply);
      if (!ctx.oauthAdmin) return reply.code(501).send(noDb);
      return reply.send({ clients: await ctx.oauthAdmin.clients.list() });
    }),
  );

  app.post(
    '/admin/oauth/clients',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!(await ctx.access.can(admin, 'key:create', {}))) return forbidden(reply);
      if (!ctx.oauthAdmin) return reply.code(501).send(noDb);
      const b = body(request);
      const clientId = strMax(b['clientId'], 128);
      const name = strMax(b['name'], 256);
      const orgId = str(b['orgId']);
      const workspaceId = str(b['workspaceId']);
      if (!clientId || !name || !orgId || !workspaceId) {
        return reply.code(422).send({
          error: { type: 'validation', message: 'clientId, name, orgId, workspaceId required' },
        });
      }
      if (!/^[A-Za-z0-9._:-]+$/.test(clientId))
        return reply.code(422).send({
          error: { type: 'validation', message: 'clientId may contain [A-Za-z0-9._:-] only' },
        });
      // Tenancy must resolve (the durable row has FKs; a dangling org used to 500) and
      // the workspace must belong to the org (the pair is what a grant is scoped to).
      const ws = ctx.workspaces.get(workspaceId);
      if (!ctx.orgs.get(orgId)) return notFound(reply, 'org');
      if (!ws) return notFound(reply, 'workspace');
      if (ws.orgId !== orgId)
        return reply
          .code(422)
          .send({ error: { type: 'validation', message: 'workspace is not in orgId' } });
      const rawGrants = Array.isArray(b['grantTypes']) ? b['grantTypes'] : [];
      const grantTypes = rawGrants.filter((g): g is string => typeof g === 'string');
      if (grantTypes.length !== rawGrants.length || grantTypes.some((g) => !GRANT_TYPES.has(g)))
        return reply.code(422).send({
          error: {
            type: 'validation',
            message: `grantTypes must be a subset of ${[...GRANT_TYPES].join(', ')}`,
          },
        });
      const rawRedirects = Array.isArray(b['redirectAllowlist']) ? b['redirectAllowlist'] : [];
      if (rawRedirects.length > 64 || !rawRedirects.every(validRedirectEntry))
        return reply.code(422).send({
          error: {
            type: 'validation',
            message: 'redirectAllowlist entries must be absolute http(s) URLs or loopback paths',
          },
        });
      const redirectAllowlist = rawRedirects;
      await ctx.oauthAdmin.clients.upsert({
        clientId,
        name,
        orgId,
        workspaceId,
        grantTypes,
        redirectAllowlist,
        enabled: b['enabled'] !== false,
      });
      await ctx.audit.append({
        orgId,
        actor: admin.subject,
        action: 'oauth.client_saved',
        target: clientId,
        payload: { clientId, name, grantTypes },
      });
      return reply.send({ client: await ctx.oauthAdmin.clients.get(clientId) });
    }),
  );

  app.delete(
    '/admin/oauth/clients/:clientId',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!(await ctx.access.can(admin, 'key:delete', {}))) return forbidden(reply);
      if (!ctx.oauthAdmin) return reply.code(501).send(noDb);
      const clientId = (request.params as { clientId: string }).clientId;
      const deleted = await ctx.oauthAdmin.clients.delete(clientId);
      if (!deleted) return notFound(reply, 'oauth client');
      await ctx.audit.append({
        orgId: null,
        actor: admin.subject,
        action: 'oauth.client_deleted',
        target: clientId,
        payload: { clientId },
      });
      return reply.send({ deleted: true });
    }),
  );

  // --- issued grants (token families) ---
  app.get(
    '/admin/oauth/grants',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'key:read', {}))) return forbidden(reply);
      if (!ctx.oauthAdmin) return reply.code(501).send(noDb);
      return reply.send({ grants: await ctx.oauthAdmin.grants.list() });
    }),
  );

  app.post(
    '/admin/oauth/grants/:handle/revoke',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!(await ctx.access.can(admin, 'key:create', {}))) return forbidden(reply);
      if (!ctx.oauthAdmin) return reply.code(501).send(noDb);
      const handle = (request.params as { handle: string }).handle;
      if (!(await ctx.oauthAdmin.grants.revoke(handle))) return notFound(reply, 'grant');
      await ctx.audit.append({
        orgId: null,
        actor: admin.subject,
        action: 'oauth.grant_revoked',
        target: handle,
        payload: { handle },
      });
      return reply.send({ revoked: true });
    }),
  );

  // --- pending device authorizations ---
  app.get(
    '/admin/oauth/device-codes',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'key:read', {}))) return forbidden(reply);
      if (!ctx.oauthAdmin) return reply.code(501).send(noDb);
      // Secret-free view (never the device_code / user_code secrets in bulk listing).
      const devices = await ctx.oauthAdmin.devices.list();
      return reply.send({
        deviceCodes: devices.map((d) => ({
          clientId: d.clientId,
          status: d.status,
          principalId: d.principalId,
          displayName: d.displayName,
          expiresAt: new Date(d.expiresAt).toISOString(),
        })),
      });
    }),
  );

  // --- refresh-token reuse (theft) feed, derived from the audit log ---
  app.get(
    '/admin/security/refresh-reuse',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!(await ctx.access.can(admin, 'audit:verify', {}))) return forbidden(reply);
      const q = request.query as Record<string, string | undefined>;
      const limit = Math.min(Math.max(Number(q['limit']) || 50, 1), 200);
      // One bounded, action-filtered read (was: the whole audit chain, filtered in JS).
      const rows = await ctx.auditByAction('oauth.refresh_reuse', limit);
      const alerts = rows.map((r) => ({
        seq: r.seq,
        handle: r.target,
        payload: r.payload,
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      }));
      return reply.send({ alerts });
    }),
  );
}
