import { applyConfig, detectDrift, isConfigDocument, plan } from '@gulley/config';
import { coveredOrgIds } from '@gulley/rbac';
import type { FastifyInstance } from 'fastify';
import { adminRoute, body } from './admin';
import { ControlConfigStore } from './config-store';
import type { ControlContext } from './context';

function applyErrorStatus(kind: string): number {
  switch (kind) {
    case 'forbidden':
      return 403;
    case 'stale':
      return 409;
    case 'inline_secret':
    case 'egress':
      return 422;
    default:
      return 500;
  }
}

/** GitOps surface: export the config as a document, dry-run a plan, apply through
 *  the guarded (audit + RBAC + secret + concurrency) path, and report drift. */
export function registerConfigRoutes(app: FastifyInstance, ctx: ControlContext): void {
  const store = new ControlConfigStore(ctx);
  const readableOrgs = (covered: readonly string[] | '*'): ReadonlySet<string> | '*' =>
    covered === '*' ? '*' : new Set(covered);

  app.get(
    '/config/export',
    adminRoute(ctx, async (_req, reply, admin) => {
      const doc = await store.exportDocument(readableOrgs(coveredOrgIds(admin)));
      return reply.send({ document: doc });
    }),
  );

  app.post(
    '/config/plan',
    adminRoute(ctx, async (request, reply, admin) => {
      const desired = body(request)['document'];
      if (!isConfigDocument(desired)) {
        return reply
          .code(422)
          .send({ error: { type: 'validation', message: 'not a config document' } });
      }
      const summary = await plan(desired, store, readableOrgs(coveredOrgIds(admin)));
      return reply.send({ plan: summary });
    }),
  );

  app.post(
    '/config/apply',
    adminRoute(ctx, async (request, reply, admin) => {
      const b = body(request);
      const desired = b['document'];
      const baseVersion = Number(b['baseVersion']);
      if (!isConfigDocument(desired) || !Number.isInteger(baseVersion)) {
        return reply
          .code(422)
          .send({ error: { type: 'validation', message: 'document + baseVersion required' } });
      }
      const r = await applyConfig(desired, baseVersion, admin, {
        store,
        versions: ctx.configVersions,
        audit: ctx.audit,
        access: ctx.access,
        egressAllowlist: ctx.outboundAllowlist,
      });
      if (r.ok) {
        return reply.send({
          version: r.value.version,
          contentHash: r.value.contentHash,
          plan: r.value.summary,
        });
      }
      return reply.code(applyErrorStatus(r.error.kind)).send({ error: r.error });
    }),
  );

  app.get(
    '/config/drift',
    adminRoute(ctx, async (_req, reply) => {
      return reply.send(await detectDrift({ store, versions: ctx.configVersions }));
    }),
  );

  app.get(
    '/config/versions',
    adminRoute(ctx, async (_req, reply) => {
      const cur = await ctx.configVersions.current();
      return reply.send({
        version: await ctx.configVersions.currentVersion(),
        current: cur
          ? {
              version: cur.version,
              contentHash: cur.contentHash,
              actor: cur.actor,
              summary: cur.summary,
              createdAt: cur.createdAt,
            }
          : null,
      });
    }),
  );
}
