import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  decodeFocusCursor,
  FOCUS_CSV_HEADER,
  focusCsvLine,
  focusJsonlLine,
  type SessionBlockRecord,
} from '@gulley/storage';

import { adminRoute, body, forbidden, notFound, scopeForWorkspace, str, strMax } from './admin';
import type { ControlContext } from './context';
import { parseDate, readScope } from './log-routes';

/**
 * K5 per-agent FinOps surface:
 *
 *  - `GET /admin/analytics/agent-tree`  — spend by session → prompt → subagent
 *  - `GET /admin/analytics/focus`       — FOCUS 1.2 export, streamed (CSV / JSON Lines)
 *  - `GET /admin/sessions/blocked`, `POST /admin/sessions/:session/block`,
 *    `DELETE /admin/sessions/:session/block` — the session kill switch
 *
 * Reads are scoped to the caller's visible workspaces (never an unscoped query); the
 * block/unblock writes need `key:disable` at the workspace and are hash-chain
 * audited (`session.blocked` / `session.unblocked`). Everything 501s without a DB.
 */

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** A session id as the gateway accepts it: bounded printable ASCII. */
const SESSION_RE = /^[\x20-\x7e]{1,256}$/;
const MAX_BLOCK_TTL_SECONDS = 30 * 24 * 60 * 60;

function query(request: { query: unknown }): Record<string, string | undefined> {
  return (request.query ?? {}) as Record<string, string | undefined>;
}

function notSupported(reply: FastifyReply, what: string): FastifyReply {
  return reply
    .code(501)
    .send({ error: { type: 'not_supported', message: `${what} requires a database` } });
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: { type: 'invalid_request', message } });
}

function stamp(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function blockView(r: SessionBlockRecord): Record<string, unknown> {
  return {
    workspaceId: r.workspaceId,
    session: r.session,
    reason: r.reason,
    source: r.source,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
  };
}

export function registerFinopsRoutes(app: FastifyInstance, ctx: ControlContext): void {
  app.get(
    '/admin/analytics/agent-tree',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!ctx.finops) return notSupported(reply, 'the agent cost tree');
      const scope = readScope(request, ctx, admin);
      if (scope === null) return reply.send({ tree: [], rows: [], truncated: false });
      const workspaceIds = scope === 'all' ? undefined : scope;
      const q = query(request);
      const to = parseDate(q['to']) ?? new Date();
      const from = parseDate(q['from']) ?? new Date(to.getTime() - DEFAULT_WINDOW_MS);
      const session = strMax(q['session'], 256);
      const result = await ctx.finops.agentTree({ workspaceIds, from, to, session });
      return reply.send({ ...result, from: from.toISOString(), to: to.toISOString() });
    }),
  );

  // FOCUS 1.2 export over the durable ledger, streamed in 50k-row pages. The
  // continuation cursor travels in `x-next-cursor` (known before the body starts).
  app.get(
    '/admin/analytics/focus',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!ctx.finops) return notSupported(reply, 'the FOCUS export');
      const q = query(request);
      const format = q['format'] === 'jsonl' ? 'jsonl' : 'csv';
      const to = parseDate(q['to']) ?? new Date();
      const from = parseDate(q['from']) ?? new Date(to.getTime() - DEFAULT_WINDOW_MS);
      if (q['cursor'] && !decodeFocusCursor(q['cursor'])) return badRequest(reply, 'bad cursor');
      reply.header(
        'content-type',
        format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
      );
      reply.header(
        'content-disposition',
        `attachment; filename="gulley-focus-${stamp(from)}-${stamp(to)}.${format}"`,
      );
      reply.header('cache-control', 'no-store');
      reply.header('access-control-expose-headers', 'x-next-cursor');
      const scope = readScope(request, ctx, admin);
      // Nothing visible: a well-formed empty document, never an unscoped query.
      if (scope === null) return reply.send(format === 'csv' ? FOCUS_CSV_HEADER : '');
      const workspaceIds = scope === 'all' ? undefined : scope;
      const page = await ctx.finops.focusPage({ workspaceIds, from, to, cursor: q['cursor'] });
      if (page.nextCursor) reply.header('x-next-cursor', page.nextCursor);
      const line = format === 'csv' ? focusCsvLine : focusJsonlLine;
      async function* chunks(): AsyncGenerator<string, void, undefined> {
        if (format === 'csv') yield FOCUS_CSV_HEADER;
        for await (const batch of page.batches()) yield batch.map(line).join('');
      }
      return reply.send(Readable.from(chunks()));
    }),
  );

  app.get(
    '/admin/sessions/blocked',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!ctx.sessionBlocks) return notSupported(reply, 'the session kill switch');
      const scope = readScope(request, ctx, admin);
      if (scope === null) return reply.send({ blocks: [] });
      const workspaceIds = scope === 'all' ? undefined : scope;
      const includeExpired = query(request)['includeExpired'] === 'true';
      const blocks = await ctx.sessionBlocks.list({ workspaceIds, includeExpired });
      return reply.send({ blocks: blocks.map(blockView) });
    }),
  );

  app.post(
    '/admin/sessions/:session/block',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!ctx.sessionBlocks) return notSupported(reply, 'the session kill switch');
      const session = (request.params as { session: string }).session;
      if (!SESSION_RE.test(session)) return badRequest(reply, 'bad session id');
      const b = body(request);
      const workspaceId = str(b['workspaceId']);
      const reason = strMax(b['reason'], 500);
      if (!workspaceId || !reason) return badRequest(reply, 'workspaceId and reason are required');
      const ttlRaw = b['ttlSeconds'];
      let ttlSeconds: number | undefined;
      if (ttlRaw !== undefined && ttlRaw !== null) {
        const n = Number(ttlRaw);
        if (!Number.isInteger(n) || n <= 0 || n > MAX_BLOCK_TTL_SECONDS)
          return badRequest(reply, `ttlSeconds must be an integer in 1..${MAX_BLOCK_TTL_SECONDS}`);
        ttlSeconds = n;
      }
      const at = scopeForWorkspace(ctx, workspaceId);
      if (!at) return notFound(reply, 'workspace');
      if (!(await ctx.access.can(admin, 'key:disable', at))) return forbidden(reply);
      const block = await ctx.sessionBlocks.block({
        workspaceId,
        session,
        reason,
        source: 'manual',
        createdBy: admin.subject,
        ttlSeconds,
      });
      await ctx.audit.append({
        orgId: at.orgId ?? null,
        actor: admin.subject,
        action: 'session.blocked',
        target: session,
        payload: {
          workspaceId,
          session,
          reason,
          source: 'manual',
          expiresAt: block.expiresAt ? block.expiresAt.toISOString() : null,
        },
      });
      return reply.send({ block: blockView(block) });
    }),
  );

  app.delete(
    '/admin/sessions/:session/block',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!ctx.sessionBlocks) return notSupported(reply, 'the session kill switch');
      const session = (request.params as { session: string }).session;
      if (!SESSION_RE.test(session)) return badRequest(reply, 'bad session id');
      const workspaceId = str(query(request)['workspaceId']);
      if (!workspaceId) return badRequest(reply, 'workspaceId is required');
      const at = scopeForWorkspace(ctx, workspaceId);
      if (!at) return notFound(reply, 'workspace');
      if (!(await ctx.access.can(admin, 'key:disable', at))) return forbidden(reply);
      const removed = await ctx.sessionBlocks.unblock(workspaceId, session);
      if (!removed) return notFound(reply, 'session block');
      await ctx.audit.append({
        orgId: at.orgId ?? null,
        actor: admin.subject,
        action: 'session.unblocked',
        target: session,
        payload: { workspaceId, session },
      });
      return reply.send({ unblocked: true });
    }),
  );
}
