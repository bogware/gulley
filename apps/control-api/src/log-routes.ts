import type { RequestStatus, UsageBucketWidth } from '@gulley/pipeline';
import { coveredOrgIds } from '@gulley/rbac';
import type { AdminPrincipal } from '@gulley/rbac';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { adminRoute, notFound, visibleWorkspaceIds } from './admin';
import type { ControlContext } from './context';

function query(request: FastifyRequest): Record<string, string | undefined> {
  return (request.query ?? {}) as Record<string, string | undefined>;
}

/**
 * Resolve the workspace scope for a read:
 *  - 'all'  — a platform owner (a `*` membership) sees every workspace. This is the
 *    ONLY unfiltered case, and it matters in durable deployments where workspaces
 *    live in Postgres (seed / config-apply) and are not in the in-memory registry —
 *    so the in-memory `visibleWorkspaceIds` would (wrongly) hide all usage.
 *  - string[] — a scoped admin's visible workspaces (or an explicit, permitted one).
 *  - null — the caller can see nothing; return an empty result rather than leak an
 *    unscoped query.
 */
function readScope(
  request: FastifyRequest,
  ctx: ControlContext,
  admin: AdminPrincipal,
): string[] | 'all' | null {
  const wid = query(request)['workspaceId'];
  const platformOwner = coveredOrgIds(admin) === '*';
  if (wid) {
    if (platformOwner) return [wid];
    return visibleWorkspaceIds(ctx, admin).has(wid) ? [wid] : null;
  }
  if (platformOwner) return 'all';
  const visible = visibleWorkspaceIds(ctx, admin);
  return visible.size > 0 ? [...visible] : null;
}

function parseDate(v: string | undefined): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Admin log browser + usage analytics over `request_log`, scoped to the caller's
 * visible workspaces. Read-only; results are always filtered by RBAC visibility
 * (never an unscoped query), and content bodies are never returned here.
 */
export function registerLogRoutes(app: FastifyInstance, ctx: ControlContext): void {
  app.get(
    '/admin/logs',
    adminRoute(ctx, async (request, reply, admin) => {
      const scope = readScope(request, ctx, admin);
      if (scope === null) return reply.send({ entries: [] });
      const workspaceIds = scope === 'all' ? undefined : scope;
      const q = query(request);
      const page = await ctx.requestLogQuery.search({
        workspaceIds,
        provider: q['provider'],
        model: q['model'],
        status: q['status'] as RequestStatus | undefined,
        minStatusCode: q['minStatusCode'] ? Number(q['minStatusCode']) : undefined,
        from: parseDate(q['from']),
        to: parseDate(q['to']),
        limit: q['limit'] ? Number(q['limit']) : undefined,
        cursor: q['cursor'],
      });
      return reply.send(page);
    }),
  );

  app.get(
    '/admin/logs/:requestId',
    adminRoute(ctx, async (request, reply, admin) => {
      const requestId = (request.params as { requestId: string }).requestId;
      const entry = await ctx.requestLogQuery.get(requestId);
      const platformOwner = coveredOrgIds(admin) === '*';
      if (!entry || (!platformOwner && !visibleWorkspaceIds(ctx, admin).has(entry.workspaceId)))
        return notFound(reply, 'request log');
      return reply.send({ entry });
    }),
  );

  app.get(
    '/admin/analytics/usage',
    adminRoute(ctx, async (request, reply, admin) => {
      const scope = readScope(request, ctx, admin);
      if (scope === null) return reply.send({ buckets: [] });
      const workspaceIds = scope === 'all' ? undefined : scope;
      const q = query(request);
      const bucket: UsageBucketWidth =
        q['bucket'] === 'minute' || q['bucket'] === 'day' ? q['bucket'] : 'hour';
      const groupBy =
        q['groupBy'] === 'provider' || q['groupBy'] === 'model' || q['groupBy'] === 'workspace'
          ? q['groupBy']
          : undefined;
      const to = parseDate(q['to']) ?? new Date();
      const from = parseDate(q['from']) ?? new Date(to.getTime() - 24 * 60 * 60 * 1000);
      const buckets = await ctx.requestLogQuery.usage({ workspaceIds, from, to, bucket, groupBy });
      return reply.send({ buckets });
    }),
  );

  // Chargeback/showback over the DURABLE spend ledger, grouped by a dimension:
  // workspace | model | provider | attr:<tag> (a cost-attribution tag such as
  // repo/branch/developer/session). RBAC-scoped to the caller's visible workspaces.
  app.get(
    '/admin/analytics/chargeback',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!ctx.chargeback) {
        return reply
          .code(501)
          .send({ error: { type: 'not_supported', message: 'chargeback requires a database' } });
      }
      const scope = readScope(request, ctx, admin);
      if (scope === null) return reply.send({ rows: [] });
      const workspaceIds = scope === 'all' ? undefined : scope;
      const gb = query(request)['groupBy'];
      const groupBy =
        gb === 'workspace' || gb === 'provider' || (gb && gb.startsWith('attr:')) ? gb : 'model';
      const to = parseDate(query(request)['to']) ?? new Date();
      const from =
        parseDate(query(request)['from']) ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
      const rows = await ctx.chargeback({ groupBy, from, to, workspaceIds });
      return reply.send({ rows });
    }),
  );

  // Shadow-spend reconciliation: each provider's own billed spend (from its usage/
  // cost API) vs what the gateway ledger mediated, over the window. A provider whose
  // bypassed share crosses the threshold is `flagged` — the CISO bypass alert.
  // RBAC-scoped to the caller's visible workspaces (the ledger side); the provider
  // side is org-wide, so an org admin sees the true bypass, a scoped viewer sees a
  // conservative (larger) apparent shadow for their slice.
  app.get(
    '/admin/analytics/shadow-spend',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!ctx.shadowSpend) {
        return reply.code(501).send({
          error: {
            type: 'not_supported',
            message: 'shadow-spend reconciliation requires a database',
          },
        });
      }
      const scope = readScope(request, ctx, admin);
      if (scope === null) return reply.send({ rows: [], flagged: false });
      const workspaceIds = scope === 'all' ? undefined : scope;
      const to = parseDate(query(request)['to']) ?? new Date();
      const from =
        parseDate(query(request)['from']) ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
      const report = await ctx.shadowSpend({ from, to, workspaceIds });
      return reply.send(report);
    }),
  );
}
