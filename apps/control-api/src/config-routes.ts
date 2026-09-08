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
    case 'validation':
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
  // Durable Postgres config store when configured, else the in-memory one.
  const store = ctx.configStore ?? new ControlConfigStore(ctx);
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
        atomic: ctx.configAtomic,
        egressAllowlist: ctx.outboundAllowlist,
        onApplied: ctx.notifier
          ? (e) =>
              ctx.notifier?.emit({
                v: e.version,
                hash: e.contentHash,
                origin: ctx.originId,
                ts: Date.now(),
              })
          : undefined,
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

  // Newest-first applied-version timeline (rollback is a GitOps re-apply of a prior
  // exported document; historical document bodies aren't retained, only their metadata).
  app.get(
    '/config/versions/history',
    adminRoute(ctx, async (request, reply) => {
      const q = request.query as Record<string, string | undefined>;
      const limit = Math.min(Math.max(Number(q['limit']) || 50, 1), 200);
      const history = ctx.configVersions.history ? await ctx.configVersions.history(limit) : [];
      return reply.send({
        versions: history.map((r) => ({
          version: r.version,
          contentHash: r.contentHash,
          actor: r.actor,
          summary: r.summary,
          createdAt: r.createdAt,
        })),
      });
    }),
  );
}
