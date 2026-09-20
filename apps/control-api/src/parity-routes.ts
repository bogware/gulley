import { GULLEY_VERSION } from '@gulley/core';
import { assertEgressAllowed, EgressError } from '@gulley/egress';
import type { FastifyInstance } from 'fastify';

import { adminRoute, body, forbidden, notFound, scopeForProvider, str, uuidParam } from './admin';
import type { ControlContext } from './context';
import { consoleWrite } from './durable-config';

/**
 * Console-parity read/update endpoints that don't belong to an existing route module:
 * a paginated audit-row browser, a subsystem-configured status roll-up, an admin-user
 * directory, and provider update + credential-metadata (so the Providers inspector can
 * enable/disable, re-point, and show whether a secret ref is set).
 */
export function registerParityRoutes(app: FastifyInstance, ctx: ControlContext): void {
  // --- audit-row browser (the Compliance console's audit trail table) ---
  app.get(
    '/audit/events',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!(await ctx.access.can(admin, 'audit:verify', {}))) return forbidden(reply);
      const q = request.query as Record<string, string | undefined>;
      const limit = Math.min(Math.max(Number(q['limit']) || 100, 1), 500);
      const beforeRaw = q['before'] !== undefined ? Number(q['before']) : undefined;
      const before = beforeRaw !== undefined && Number.isFinite(beforeRaw) ? beforeRaw : undefined;
      // Newest first; keyset by seq (before = exclusive upper bound). One bounded page
      // from the backend — the whole chain is no longer read per request.
      const page = await ctx.auditPage({ before, limit });
      return reply.send({
        events: page.map((r) => ({
          seq: r.seq,
          orgId: r.orgId,
          actor: r.actor,
          action: r.action,
          target: r.target,
          payload: r.payload,
          createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
        })),
        nextCursor: page.length === limit ? page[page.length - 1]?.seq : undefined,
      });
    }),
  );

  // --- subsystem-configured status roll-up (Settings/Status landing) ---
  app.get(
    '/admin/status',
    adminRoute(ctx, async (_request, reply, admin) => {
      if (!(await ctx.access.can(admin, 'config:read', {}))) return forbidden(reply);
      return reply.send({
        version: GULLEY_VERSION,
        durable: Boolean(ctx.adminUsers), // a DB is wired (else in-memory stores)
        subsystems: {
          worm: Boolean(ctx.wormShipper),
          anchoring: Boolean(ctx.anchor),
          siem: Boolean(ctx.siemExporter),
          auditSigning: Boolean(ctx.auditSigner ?? ctx.attestationKey),
          evalRollout: Boolean(ctx.evalRunner),
          maskVault: Boolean(ctx.maskVault && ctx.maskVaultEncryptor),
          cryptoShred: Boolean(ctx.subjectKeys),
          chargeback: Boolean(ctx.chargeback),
          shadowSpend: Boolean(ctx.shadowSpend),
          gatewayMetrics: Boolean(ctx.gatewayMetrics),
          oidc: Boolean(ctx.oidc),
          onboarding: Boolean(ctx.onboardingSigningKey),
          clientConfig: Boolean(ctx.gatewayPublicUrl),
        },
      });
    }),
  );

  // --- admin-user directory (Identity > Users) ---
  app.get(
    '/admin/users',
    adminRoute(ctx, async (_request, reply, admin) => {
      if (!(await ctx.access.can(admin, 'membership:read', {}))) return forbidden(reply);
      const users = ctx.adminUsers ? await ctx.adminUsers.list() : [];
      return reply.send({
        durable: Boolean(ctx.adminUsers),
        users: users.map((u) => ({
          id: u.id,
          subject: u.subject,
          displayName: u.displayName,
          email: u.email,
        })),
      });
    }),
  );

  app.get(
    '/admin/users/:id/memberships',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!(await ctx.access.can(admin, 'membership:read', {}))) return forbidden(reply);
      const id = uuidParam(request);
      const user = id && ctx.adminUsers ? await ctx.adminUsers.get(id) : undefined;
      if (!user) return notFound(reply, 'user');
      const grants = ctx.durableMemberships
        ? await ctx.durableMemberships.membershipsForSubject(user.subject)
        : [];
      return reply.send({ user: { id: user.id, subject: user.subject }, memberships: grants });
    }),
  );

  // --- provider update (enable/disable, re-point) ---
  app.put(
    '/providers/:id',
    adminRoute(ctx, async (request, reply, admin) => {
      const id = (request.params as { id: string }).id;
      const at = scopeForProvider(ctx, id);
      if (!at) return notFound(reply, 'provider');
      const b = body(request);
      const baseUrl = str(b['baseUrl']);
      if (baseUrl !== undefined && baseUrl.length > 0) {
        try {
          assertEgressAllowed(baseUrl, { allowlist: ctx.outboundAllowlist });
        } catch (e) {
          if (e instanceof EgressError)
            return reply.code(422).send({
              error: {
                type: 'egress',
                message: 'baseUrl is not an allowed egress destination',
                reason: e.reason,
              },
            });
          throw e;
        }
      }
      const patch: { enabled?: boolean; baseUrl?: string } = {};
      if (typeof b['enabled'] === 'boolean') patch.enabled = b['enabled'];
      if (baseUrl !== undefined) patch.baseUrl = baseUrl;
      const r = await consoleWrite(ctx, admin, {
        perm: 'provider:update',
        at,
        action: 'provider.update',
        target: id,
        diff: patch,
        memory: () => ctx.providers.update(id, patch),
        durable: async (b) => {
          const p = await b.updateProviderById(id, patch);
          return p
            ? {
                id: p.id,
                workspaceId: p.workspaceId,
                kind: p.kind,
                baseUrl: p.baseUrl,
                enabled: p.enabled,
              }
            : undefined;
        },
      });
      if (!r.ok) return forbidden(reply);
      if (!r.value) return notFound(reply, 'provider');
      return reply.send({ provider: r.value });
    }),
  );

  // --- credential metadata (is a secret ref set? — never the value) ---
  app.get(
    '/providers/:id/credential',
    adminRoute(ctx, async (request, reply, admin) => {
      const id = (request.params as { id: string }).id;
      const at = scopeForProvider(ctx, id);
      if (!at) return notFound(reply, 'provider');
      if (!(await ctx.access.can(admin, 'provider:read', at))) return forbidden(reply);
      const cred = ctx.credentials.get(id);
      return reply.send({ configured: Boolean(cred), ref: cred ? cred.credential : undefined });
    }),
  );
}
