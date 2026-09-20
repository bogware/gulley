import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { createInMemoryControlContext, SignalingAuditSink, type ControlContext } from './context';
import { buildServer } from './server';

/**
 * Control-plane hardening (refine cycle 2026-09), in-memory mode: delegated session
 * minting can no longer impersonate, logout revokes, error bodies are uniform, path
 * ids are validated, platform grants work, config audit diffs say what changed, and a
 * lost audit row is a first-class failure.
 */
let app: FastifyInstance;
let ctx: ControlContext;
let gadm: string;
let orgId: string;
let workspaceId: string;

const auth = (bearer = gadm) => ({
  authorization: `Bearer ${bearer}`,
  'content-type': 'application/json',
});
const post = (url: string, payload: unknown, bearer = gadm) =>
  app.inject({ method: 'POST', url, headers: auth(bearer), payload: JSON.stringify(payload) });
const get = (url: string, bearer = gadm) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${bearer}` } });

beforeEach(async () => {
  gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  ctx = createInMemoryControlContext({
    pepper: 'control-hardening-pepper-16chars!!',
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: ['control-hardening-session-secret-32bytes!'],
    maxSessionTtlMs: 900_000,
  });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
  orgId = ((await post('/orgs', { name: 'Acme' }).then((r) => r.json())) as { org: { id: string } })
    .org.id;
  workspaceId = (
    (await post('/workspaces', { orgId, name: 'prod' }).then((r) => r.json())) as {
      workspace: { id: string };
    }
  ).workspace.id;
});

afterEach(async () => {
  await app.close();
});

describe('POST /admin/sessions — delegated tokens cannot impersonate (F1/F20)', () => {
  it('ignores a caller-chosen subject: the token is the minter, the label is only a name', async () => {
    const r = await post('/admin/sessions', {
      subject: 'someone-else',
      name: 'ci-viewer',
      memberships: [{ role: 'viewer', orgId }],
    });
    expect(r.statusCode).toBe(201);
    const token = (r.json() as { token: string }).token;
    const me = await get('/auth/me', token);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ subject: 'bootstrap-admin', name: 'ci-viewer' });
    // The delegated token carries exactly the granted membership — not the minter's.
    expect((me.json() as { memberships: unknown[] }).memberships).toEqual([
      { role: 'viewer', orgId, workspaceId: null },
    ]);
    // …and the session registry records the minter as the subject.
    const sessions = (await ctx.sessions.list!()).filter((s) => s.source === 'exchange');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.subject).toBe('bootstrap-admin');
  });

  it('requires at least one membership (an empty grant list bypassed every permission check)', async () => {
    const r = await post('/admin/sessions', { subject: 'x', memberships: [] });
    expect(r.statusCode).toBe(422);
    expect((await post('/admin/sessions', {})).statusCode).toBe(422);
  });

  it('clamps a negative / absurd ttl and caps the label length', async () => {
    const neg = await post('/admin/sessions', {
      ttlSeconds: -5,
      memberships: [{ role: 'viewer', orgId }],
    });
    expect(neg.statusCode).toBe(201);
    const exp = Date.parse((neg.json() as { expiresAt: string }).expiresAt);
    expect(exp - Date.now()).toBeGreaterThan(800_000); // fell back to the 900 s default
    expect(exp - Date.now()).toBeLessThanOrEqual(900_500);

    const huge = await post('/admin/sessions', {
      ttlSeconds: 10_000_000,
      memberships: [{ role: 'viewer', orgId }],
    });
    const exp2 = Date.parse((huge.json() as { expiresAt: string }).expiresAt);
    expect(exp2 - Date.now()).toBeLessThanOrEqual(900_500); // capped at maxSessionTtl

    const long = await post('/admin/sessions', {
      name: 'x'.repeat(129),
      memberships: [{ role: 'viewer', orgId }],
    });
    expect(long.statusCode).toBe(422);
  });

  it('still refuses amplification (an admin cannot mint an owner)', async () => {
    const adminTok = (
      (await post('/admin/sessions', { memberships: [{ role: 'admin', orgId }] }).then((r) =>
        r.json(),
      )) as { token: string }
    ).token;
    const esc = await post(
      '/admin/sessions',
      { memberships: [{ role: 'owner', orgId }] },
      adminTok,
    );
    expect(esc.statusCode).toBe(403);
  });
});

describe('POST /auth/logout revokes the session (F3)', () => {
  it('a bearer that logs out is rejected afterwards, and the logout is audited', async () => {
    const token = (
      (await post('/admin/sessions', { memberships: [{ role: 'viewer', orgId }] }).then((r) =>
        r.json(),
      )) as { token: string }
    ).token;
    expect((await get('/auth/me', token)).statusCode).toBe(200);
    const out = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(out.statusCode).toBe(204);
    expect((await get('/auth/me', token)).statusCode).toBe(401);
    const events = (await get('/audit/events?limit=5')).json() as {
      events: Array<{ action: string }>;
    };
    expect(events.events.some((e) => e.action === 'admin.session.logout')).toBe(true);
    // Idempotent without a token.
    expect((await app.inject({ method: 'POST', url: '/auth/logout' })).statusCode).toBe(204);
  });
});

describe('uniform error bodies (F7)', () => {
  it('an unexpected throw is a generic 500 carrying the request id, never the message', async () => {
    // A fresh server (the shared one is already listening) with one route that throws
    // the kind of driver error the default handler used to echo verbatim.
    const fresh = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
    fresh.get('/boom', async () => {
      throw new Error('invalid input syntax for type uuid: "x" at host db.internal:5432');
    });
    const r = await fresh.inject({ method: 'GET', url: '/boom' });
    await fresh.close();
    expect(r.statusCode).toBe(500);
    const body = r.json() as { error: { type: string; message: string; requestId: string } };
    expect(body.error.type).toBe('internal');
    expect(body.error.message).toBe('internal error');
    expect(body.error.requestId).toBe(r.headers['x-gulley-request-id']);
    expect(JSON.stringify(body)).not.toContain('db.internal');
  });

  it('a malformed JSON body is still a 400 with its parse message', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/orgs',
      headers: auth(),
      payload: '{not json',
    });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: { type: string } }).error.type).toBe('bad_request');
  });

  it('a lost audit row is an audit_unavailable 500 (the mutation may have applied)', async () => {
    ctx.audit = new SignalingAuditSink({
      append: async () => {
        throw new Error('connection refused 10.0.0.9:5432');
      },
    });
    const r = await post('/orgs', { name: 'Unaudited' });
    expect(r.statusCode).toBe(500);
    const body = r.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe('audit_unavailable');
    expect(JSON.stringify(body)).not.toContain('10.0.0.9');
    // The org WAS created (non-atomic in-memory path) — the response says so honestly.
    expect(ctx.orgs.list('*').some((o) => o.name === 'Unaudited')).toBe(true);
  });
});

describe('path ids and scope sentinels (F8/F14)', () => {
  it('a malformed key id is a 404, not a cast error', async () => {
    expect((await get('/keys/not-a-uuid')).statusCode).toBe(404);
    const r = await app.inject({
      method: 'POST',
      url: '/keys/not-a-uuid/disable',
      headers: { authorization: `Bearer ${gadm}` },
    });
    expect(r.statusCode).toBe(404);
  });

  it('a platform-wide grant (orgId "*") is accepted and audited with a null org', async () => {
    const r = await post('/memberships', { userId: 'u-root', role: 'owner', orgId: '*' });
    expect(r.statusCode).toBe(201);
    const events = (await get('/audit/events?limit=3')).json() as {
      events: Array<{ action: string; orgId: string | null }>;
    };
    const row = events.events.find((e) => e.action === 'membership.create');
    expect(row?.orgId).toBeNull();
    // A workspace makes no sense on a platform grant.
    const bad = await post('/memberships', {
      userId: 'u',
      role: 'viewer',
      orgId: '*',
      workspaceId,
    });
    expect(bad.statusCode).toBe(422);
  });
});

describe('collection update audit diff (F16) and fixed egress errors', () => {
  it('records whether the name and/or config changed, with content hashes', async () => {
    const created = await post('/routes', { workspaceId, name: 'r', config: { a: 1 } });
    const id = (created.json() as { entity: { id: string } }).entity.id;
    const upd = await app.inject({
      method: 'PUT',
      url: `/routes/${id}`,
      headers: auth(),
      payload: JSON.stringify({ config: { a: 2 } }),
    });
    expect(upd.statusCode).toBe(200);
    const events = (await get('/audit/events?limit=3')).json() as {
      events: Array<{ action: string; payload: Record<string, unknown> }>;
    };
    const row = events.events.find((e) => e.action === 'route.update')!;
    expect(row.payload).toMatchObject({ nameChanged: false, configChanged: true });
    expect(row.payload['configHashBefore']).not.toBe(row.payload['configHashAfter']);
  });

  it('an egress-blocked provider baseUrl yields a fixed message plus a reason code', async () => {
    const r = await post('/providers', {
      workspaceId,
      kind: 'openai',
      baseUrl: 'http://169.254.169.254/latest',
    });
    expect(r.statusCode).toBe(422);
    const body = r.json() as { error: { message: string; reason: string } };
    expect(body.error.message).toBe('baseUrl is not an allowed egress destination');
    expect(body.error.reason).toBeTruthy();
  });
});
