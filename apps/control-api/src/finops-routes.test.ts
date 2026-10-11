import { createHash, randomBytes } from 'node:crypto';
import {
  type AgentCostTree,
  FOCUS_COLUMNS,
  type FocusPageStreamQuery,
  type FocusRow,
  InMemorySessionBlockStore,
  toFocusRow,
} from '@gulley/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config';
import { type ControlContext, createInMemoryControlContext } from './context';
import { buildServer } from './server';

const PEPPER = 'finops-check-pepper-at-least-16-chars';
const SESSION_SECRET = 'finops-check-session-secret-32-chars-min!!';

let app: FastifyInstance;
let ctx: ControlContext;
let gadm: string;
let treeCalls: Array<Record<string, unknown>>;
let focusCalls: FocusPageStreamQuery[];

function call(method: 'GET' | 'POST' | 'DELETE', url: string, token: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    // A content-type on a body-less DELETE makes Fastify 400 before any handler runs.
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

function focusRow(over: { requestId: string; session: string; costMicroUsd?: number }): FocusRow {
  return toFocusRow({
    id: over.requestId,
    requestId: over.requestId,
    principalId: 'vk_1',
    orgId: null,
    orgName: null,
    workspaceId: null,
    workspaceName: null,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    status: 'ok',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheSavedMicroUsd: 0,
    costMicroUsd: over.costMicroUsd ?? 1500,
    attributes: { session: over.session },
    createdAt: new Date(Date.UTC(2026, 9, 10, 12, 0)),
  });
}

const TREE: AgentCostTree = {
  truncated: false,
  rows: [],
  tree: [
    {
      workspaceId: 'ws',
      session: 's1',
      principalId: 'vk_1',
      firstAt: '2026-10-10T12:00:00.000Z',
      lastAt: '2026-10-10T12:05:00.000Z',
      requests: 2,
      legs: 2,
      inputTokens: 20,
      outputTokens: 10,
      costMicroUsd: 3000,
      cacheSavedMicroUsd: 0,
      compactionMicroUsd: 1000,
      subagentMicroUsd: 0,
      prompts: [],
    },
  ],
};

beforeEach(async () => {
  gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  treeCalls = [];
  focusCalls = [];
  ctx = createInMemoryControlContext({
    pepper: PEPPER,
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: [SESSION_SECRET],
    maxSessionTtlMs: 900_000,
    finops: {
      agentTree: async (q) => {
        treeCalls.push({ ...q });
        return TREE;
      },
      focusPage: async (q) => {
        focusCalls.push(q);
        const rows = [
          focusRow({ requestId: 'r1', session: '=cmd' }),
          focusRow({ requestId: 'r2', session: 'plain' }),
          focusRow({ requestId: 'r3', session: 'c,d' }),
        ];
        return {
          nextCursor: q.cursor ? undefined : 'next-page',
          batches: async function* () {
            yield rows.slice(0, 2);
            yield rows.slice(2);
          },
        };
      },
    },
    sessionBlocks: new InMemorySessionBlockStore(),
  });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
});

afterEach(async () => {
  await app.close();
});

async function makeWorkspace(): Promise<{ orgId: string; wsId: string }> {
  const org = await call('POST', '/orgs', gadm, { name: 'Acme' });
  const orgId = (org.json().org as { id: string }).id;
  const ws = await call('POST', '/workspaces', gadm, { orgId, name: 'Default' });
  return { orgId, wsId: (ws.json().workspace as { id: string }).id };
}

async function sessionFor(role: string, orgId: string): Promise<string> {
  const sess = await call('POST', '/admin/sessions', gadm, {
    subject: `${role}@acme`,
    memberships: [{ role, orgId }],
  });
  return (sess.json() as { token: string }).token;
}

describe('FinOps routes', () => {
  it('501s every route when no FinOps backend is wired', async () => {
    const bare = createInMemoryControlContext({
      pepper: PEPPER,
      bootstrapEnabled: true,
      bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
      sessionSecrets: [SESSION_SECRET],
      maxSessionTtlMs: 900_000,
    });
    const app2 = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), bare);
    try {
      const inject = (method: 'GET' | 'POST' | 'DELETE', url: string) =>
        app2.inject({
          method,
          url,
          headers: {
            authorization: `Bearer ${gadm}`,
            ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
          },
          payload: method === 'POST' ? '{}' : undefined,
        });
      expect((await inject('GET', '/admin/analytics/agent-tree')).statusCode).toBe(501);
      expect((await inject('GET', '/admin/analytics/focus')).statusCode).toBe(501);
      expect((await inject('GET', '/admin/sessions/blocked')).statusCode).toBe(501);
      expect((await inject('POST', '/admin/sessions/s/block')).statusCode).toBe(501);
      expect((await inject('DELETE', '/admin/sessions/s/block?workspaceId=x')).statusCode).toBe(
        501,
      );
    } finally {
      await app2.close();
    }
  });

  it('requires admin credentials', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/analytics/agent-tree' });
    expect(res.statusCode).toBe(401);
  });

  it('serves the agent tree, unscoped for a platform owner and with the window echoed', async () => {
    const res = await call(
      'GET',
      '/admin/analytics/agent-tree?from=2026-10-01T00:00:00Z&to=2026-10-11T00:00:00Z&session=s1',
      gadm,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tree: unknown[]; from: string; to: string; truncated: boolean };
    expect(body.tree).toHaveLength(1);
    expect(body.from).toBe('2026-10-01T00:00:00.000Z');
    expect(body.truncated).toBe(false);
    expect(treeCalls[0]).toMatchObject({ workspaceIds: undefined, session: 's1' });
  });

  it('scopes the tree to a viewer’s visible workspaces and hides an invisible org', async () => {
    const { orgId, wsId } = await makeWorkspace();
    const viewer = await sessionFor('viewer', orgId);
    const res = await call('GET', '/admin/analytics/agent-tree', viewer);
    expect(res.statusCode).toBe(200);
    expect(treeCalls[0]?.['workspaceIds']).toEqual([wsId]);

    const other = await call('POST', '/orgs', gadm, { name: 'Other' });
    const outsider = await sessionFor('viewer', (other.json().org as { id: string }).id);
    const empty = await call('GET', '/admin/analytics/agent-tree', outsider);
    expect(empty.statusCode).toBe(200);
    expect((empty.json() as { tree: unknown[] }).tree).toEqual([]);
    expect(treeCalls).toHaveLength(1); // never queried for an invisible scope
  });

  it('streams the FOCUS export as CSV with the fixed header, escaping and a next-cursor', async () => {
    const res = await call(
      'GET',
      '/admin/analytics/focus?from=2026-10-01T00:00:00Z&to=2026-10-11T00:00:00Z',
      gadm,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="gulley-focus-2026-10-01-2026-10-11.csv"',
    );
    expect(res.headers['x-next-cursor']).toBe('next-page');
    const lines = res.body.split('\r\n').filter(Boolean);
    expect(lines[0]).toBe(FOCUS_COLUMNS.join(','));
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain(`'=cmd`); // formula-injection prefix on the session value
    expect(lines[3]).toContain(`"c,d"`); // RFC 4180 quoting
    expect(focusCalls[0]).toMatchObject({ workspaceIds: undefined, cursor: undefined });

    const page2 = await call('GET', '/admin/analytics/focus?cursor=bm90LWEtY3Vyc29y', gadm);
    expect(page2.statusCode).toBe(400); // decodable base64, not a cursor
  });

  it('streams JSON Lines with every column and no next-cursor on the last page', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ t: '2026-10-10T12:00:00.000Z', id: 'r1' }),
      'utf8',
    ).toString('base64url');
    const res = await call('GET', `/admin/analytics/focus?format=jsonl&cursor=${cursor}`, gadm);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    expect(res.headers['x-next-cursor']).toBeUndefined();
    const objs = res.body
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(objs).toHaveLength(3);
    expect(Object.keys(objs[0]!)).toEqual([...FOCUS_COLUMNS]);
    expect(objs[0]!['x_gulley_session']).toBe('=cmd');
    expect(focusCalls[0]?.cursor).toBe(cursor);
  });

  it('gives an admin with nothing visible an empty FOCUS document, never an unscoped query', async () => {
    const other = await call('POST', '/orgs', gadm, { name: 'Other' });
    const outsider = await sessionFor('viewer', (other.json().org as { id: string }).id);
    const res = await call('GET', '/admin/analytics/focus', outsider);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(`${FOCUS_COLUMNS.join(',')}\r\n`);
    expect(focusCalls).toHaveLength(0);
  });

  it('blocks and unblocks a session with key:disable, auditing both, and lists blocks by scope', async () => {
    const { orgId, wsId } = await makeWorkspace();
    expect((await call('GET', '/admin/sessions/blocked', gadm)).json()).toEqual({ blocks: [] });

    const blocked = await call('POST', '/admin/sessions/sess-1/block', gadm, {
      workspaceId: wsId,
      reason: 'looping on a failing test',
      ttlSeconds: 600,
    });
    expect(blocked.statusCode).toBe(200);
    const view = (blocked.json() as { block: Record<string, unknown> }).block;
    expect(view).toMatchObject({
      workspaceId: wsId,
      session: 'sess-1',
      reason: 'looping on a failing test',
      source: 'manual',
      createdBy: expect.any(String),
    });
    expect(typeof view['expiresAt']).toBe('string');
    expect(await ctx.sessionBlocks!.isBlocked(wsId, 'sess-1')).toBe(true);
    const audits = await ctx.auditByAction('session.blocked', 10);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      target: 'sess-1',
      orgId,
      payload: { workspaceId: wsId, source: 'manual', reason: 'looping on a failing test' },
    });

    // A viewer in the org sees the block but cannot write one; an outsider sees nothing.
    const viewer = await sessionFor('viewer', orgId);
    const list = await call('GET', '/admin/sessions/blocked', viewer);
    expect((list.json() as { blocks: unknown[] }).blocks).toHaveLength(1);
    const denied = await call('POST', '/admin/sessions/sess-2/block', viewer, {
      workspaceId: wsId,
      reason: 'nope',
    });
    expect(denied.statusCode).toBe(403);
    const other = await call('POST', '/orgs', gadm, { name: 'Other' });
    const outsider = await sessionFor('admin', (other.json().org as { id: string }).id);
    expect((await call('GET', '/admin/sessions/blocked', outsider)).json()).toEqual({ blocks: [] });
    const denied2 = await call('POST', '/admin/sessions/sess-2/block', outsider, {
      workspaceId: wsId,
      reason: 'nope',
    });
    expect(denied2.statusCode).toBe(403);

    // An editor (holds key:disable) can unblock; the removal is audited.
    const editor = await sessionFor('editor', orgId);
    const gone = await call('DELETE', `/admin/sessions/sess-1/block?workspaceId=${wsId}`, editor);
    expect(gone.statusCode).toBe(200);
    expect(gone.json()).toEqual({ unblocked: true });
    expect(await ctx.sessionBlocks!.isBlocked(wsId, 'sess-1')).toBe(false);
    const unblocks = await ctx.auditByAction('session.unblocked', 10);
    expect(unblocks).toHaveLength(1);
    // A delegated session keeps the delegating admin's subject, so the actor is the
    // same real identity that placed the block.
    expect(unblocks[0]).toMatchObject({ target: 'sess-1', actor: audits[0]!.actor, orgId });
    const again = await call('DELETE', `/admin/sessions/sess-1/block?workspaceId=${wsId}`, gadm);
    expect(again.statusCode).toBe(404);
  });

  it('validates the block request', async () => {
    const { wsId } = await makeWorkspace();
    expect(
      (await call('POST', '/admin/sessions/sess/block', gadm, { workspaceId: wsId })).statusCode,
    ).toBe(400); // no reason
    expect(
      (
        await call('POST', '/admin/sessions/sess/block', gadm, {
          workspaceId: wsId,
          reason: 'r',
          ttlSeconds: -5,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call('POST', '/admin/sessions/sess/block', gadm, {
          workspaceId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
          reason: 'r',
        })
      ).statusCode,
    ).toBe(404); // unknown workspace
    const control = await call(
      'POST',
      `/admin/sessions/${encodeURIComponent('a\u0001b')}/block`,
      gadm,
      {
        workspaceId: wsId,
        reason: 'r',
      },
    );
    expect(control.statusCode).toBe(400); // non-printable session id
    expect((await call('DELETE', '/admin/sessions/sess/block', gadm)).statusCode).toBe(400); // missing workspaceId
  });
});
