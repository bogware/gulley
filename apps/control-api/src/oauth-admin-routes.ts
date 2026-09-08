import type { FastifyInstance } from 'fastify';

import { adminRoute, body, forbidden, notFound, str } from './admin';
import type { ControlContext } from './context';

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
      const clientId = str(b['clientId']);
      const name = str(b['name']);
      const orgId = str(b['orgId']);
      const workspaceId = str(b['workspaceId']);
      if (!clientId || !name || !orgId || !workspaceId) {
        return reply.code(422).send({
          error: { type: 'validation', message: 'clientId, name, orgId, workspaceId required' },
        });
      }
      const grantTypes = Array.isArray(b['grantTypes']) ? (b['grantTypes'] as string[]) : [];
      const redirectAllowlist = Array.isArray(b['redirectAllowlist'])
        ? (b['redirectAllowlist'] as string[])
        : [];
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
      await ctx.oauthAdmin.grants.revoke(handle);
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
      const rows = (await ctx.auditRows?.()) ?? [];
      const alerts = rows
        .filter((r) => r.action === 'oauth.refresh_reuse')
        .sort((a, b) => b.seq - a.seq)
        .slice(0, limit)
        .map((r) => ({
          seq: r.seq,
          handle: r.target,
          payload: r.payload,
          createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
        }));
      return reply.send({ alerts });
    }),
  );
}
