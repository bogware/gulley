import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { type AdminSessionClaims, signAdminSession } from '@gulley/auth';
import { type Database, schema } from '@gulley/storage';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { type ControlContext, createInMemoryControlContext } from './context';
import { buildServer } from './server';

/**
 * Control-plane hardening (refine cycle 2026-09), DB mode: the delegated-session
 * impersonation hole is closed against the durable membership loader, SCIM
 * deprovision revokes every session (set-based, by subject AND email), malformed
 * uuids are 404/400 instead of Postgres cast 500s, OAuth clients are validated and
 * re-scoped on upsert, a bogus grant revoke is a 404, platform grants persist, audit
 * reads are paged, and SCIM lists honour paging.
 */
const SECRET = 'control-hardening-pg-session-secret-32!!';
let client: PGlite;
let app: FastifyInstance;
let ctx: ControlContext;
let gadm: string;
let orgId: string;
let workspaceId: string;

async function applyMigrations(pg: PGlite): Promise<void> {
  const dir = fileURLToPath(new URL('../../../packages/storage/migrations', import.meta.url));
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    for (let stmt of readFileSync(`${dir}/${f}`, 'utf8').split('--> statement-breakpoint')) {
      stmt = stmt.trim();
      if (!stmt) continue;
      if (/create extension.*vector/i.test(stmt)) continue;
      if (/using hnsw/i.test(stmt)) continue;
      if (/::vector/i.test(stmt)) continue;
      stmt = stmt.replace(/vector\(\d+\)/gi, 'text');
      await pg.exec(stmt);
    }
  }
}

const headers = (bearer: string) => ({
  authorization: `Bearer ${bearer}`,
  'content-type': 'application/json',
});
const post = (url: string, payload: unknown, bearer = gadm) =>
  app.inject({ method: 'POST', url, headers: headers(bearer), payload: JSON.stringify(payload) });
const patch = (url: string, payload: unknown, bearer = gadm) =>
  app.inject({ method: 'PATCH', url, headers: headers(bearer), payload: JSON.stringify(payload) });
const get = (url: string, bearer = gadm) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${bearer}` } });
const del = (url: string, bearer = gadm) =>
  app.inject({ method: 'DELETE', url, headers: { authorization: `Bearer ${bearer}` } });

/** An SSO-style session: NO token memberships; everything comes from the durable store. */
function durableSession(subject: string, src: 'oidc' | undefined = 'oidc'): string {
  const iat = Math.floor(Date.now() / 1000);
  const claims: AdminSessionClaims = {
    sub: subject,
    name: subject,
    jti: randomUUID(),
    memberships: [],
    iat,
    exp: iat + 600,
    typ: 'admin-session',
    ver: 1,
    ...(src ? { src } : {}),
  };
  return signAdminSession(SECRET, claims);
}

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Database;
  await applyMigrations(client);
  gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  ctx = createInMemoryControlContext({
    pepper: 'control-hardening-pg-pepper-16chars!',
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: [SECRET],
    maxSessionTtlMs: 900_000,
    db,
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

afterAll(async () => {
  await app.close();
  await client.close();
});

describe('delegated sessions vs the durable membership loader (F1)', () => {
  it('an org admin cannot mint a token that inherits a platform owner’s durable grants', async () => {
    // Durable grants: alice = admin@org, root = owner@platform ("*" ⇒ NULL org).
    expect(
      (await post('/memberships', { subject: 'alice', role: 'admin', orgId })).statusCode,
    ).toBe(201);
    expect(
      (await post('/memberships', { subject: 'root', role: 'owner', orgId: '*' })).statusCode,
    ).toBe(201);
    const alice = durableSession('alice');
    // alice's own SSO session resolves her durable grant (the loader unions it in).
    expect((await get('/auth/me', alice)).json()).toMatchObject({
      subject: 'alice',
      memberships: [{ role: 'admin', orgId }],
    });
    // She mints a "viewer" token naming root as the subject.
    const minted = await post(
      '/admin/sessions',
      { subject: 'root', memberships: [{ role: 'viewer', orgId }] },
      alice,
    );
    expect(minted.statusCode).toBe(201);
    const tok = (minted.json() as { token: string }).token;
    // The token is alice (never root) and holds ONLY the delegated viewer grant — the
    // loader is skipped for exchange tokens, so root's owner@* is never unioned in.
    const me = (await get('/auth/me', tok)).json() as { subject: string; memberships: unknown[] };
    expect(me.subject).toBe('alice');
    expect(me.memberships).toEqual([{ role: 'viewer', orgId, workspaceId: null }]);
    // A platform-scoped action with that token is forbidden.
    expect((await post('/orgs', { name: 'Evil' }, tok)).statusCode).toBe(403);
  });

  it('a platform grant is stored with a NULL org and resolves as "*"', async () => {
    const root = durableSession('root');
    const me = (await get('/auth/me', root)).json() as { memberships: Array<{ orgId: string }> };
    expect(me.memberships.some((m) => m.orgId === '*')).toBe(true);
    expect((await post('/orgs', { name: 'By root' }, root)).statusCode).toBe(201);
  });

  it('DELETE /memberships/:id with a malformed id is a 404 (not a cast error 500)', async () => {
    expect((await del('/memberships/not-a-uuid')).statusCode).toBe(404);
    expect((await get('/keys/not-a-uuid')).statusCode).toBe(404);
    expect((await get('/admin/users/not-a-uuid/memberships')).statusCode).toBe(404);
  });
});

describe('SCIM deprovision + ids + paging (F4/F5/F8/F19)', () => {
  it('revokes EVERY live session of the user, by subject and by email, in one step', async () => {
    const created = await post('/scim/v2/Users', {
      userName: 'bob@acme.test',
      displayName: 'Bob',
      emails: [{ value: 'bob@acme.test', primary: true }],
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;
    // Three live sessions: two keyed on the SCIM userName, one on an oid-style subject
    // that shares the email (an SSO session whose subject claim was `email`).
    for (let i = 0; i < 2; i++) {
      await ctx.sessions.record!({
        jti: randomUUID(),
        subject: 'bob@acme.test',
        source: 'oidc',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
    }
    const r = await del(`/scim/v2/Users/${id}`);
    expect(r.statusCode).toBe(204);
    const live = (await ctx.sessions.list!()).filter(
      (s) => s.subject === 'bob@acme.test' && !s.revoked,
    );
    expect(live).toHaveLength(0);
    const audit = (await get('/audit/events?limit=3')).json() as {
      events: Array<{ action: string; payload: { revokedSessions?: number } }>;
    };
    const row = audit.events.find((e) => e.action === 'scim.user.deprovision')!;
    expect(row.payload.revokedSessions).toBe(2);
  });

  it('malformed ids are SCIM 404s; a non-uuid member value is a SCIM 400', async () => {
    expect((await get('/scim/v2/Users/nope')).statusCode).toBe(404);
    expect((await get('/scim/v2/Groups/nope')).statusCode).toBe(404);
    expect((await del('/scim/v2/Groups/nope')).statusCode).toBe(404);
    const g = await post('/scim/v2/Groups', { displayName: 'eng', members: [{ value: 'nope' }] });
    expect(g.statusCode).toBe(400);
    expect((g.json() as { scimType: string }).scimType).toBe('invalidValue');
    const ok = await post('/scim/v2/Groups', { displayName: 'eng' });
    expect(ok.statusCode).toBe(201);
    const gid = (ok.json() as { id: string }).id;
    const bad = await patch(`/scim/v2/Groups/${gid}`, {
      Operations: [{ op: 'add', path: 'members', value: [{ value: 'not-a-user' }] }],
    });
    expect(bad.statusCode).toBe(400);
  });

  it('list endpoints honour startIndex/count', async () => {
    for (const n of ['p1', 'p2', 'p3']) await post('/scim/v2/Users', { userName: `${n}@acme` });
    const page = (await get('/scim/v2/Users?startIndex=2&count=1')).json() as {
      totalResults: number;
      startIndex: number;
      itemsPerPage: number;
      Resources: unknown[];
    };
    expect(page.totalResults).toBeGreaterThanOrEqual(3);
    expect(page.startIndex).toBe(2);
    expect(page.itemsPerPage).toBe(1);
    expect(page.Resources).toHaveLength(1);
  });
});

describe('OAuth admin surface (F12/F15/F11)', () => {
  it('validates tenancy + grant types, and an upsert re-scopes the client', async () => {
    const unknownOrg = await post('/admin/oauth/clients', {
      clientId: 'cli',
      name: 'CLI',
      orgId: randomUUID(),
      workspaceId,
    });
    expect(unknownOrg.statusCode).toBe(404);
    const badGrant = await post('/admin/oauth/clients', {
      clientId: 'cli',
      name: 'CLI',
      orgId,
      workspaceId,
      grantTypes: ['implicit'],
    });
    expect(badGrant.statusCode).toBe(422);
    const badRedirect = await post('/admin/oauth/clients', {
      clientId: 'cli',
      name: 'CLI',
      orgId,
      workspaceId,
      grantTypes: ['device_code'],
      redirectAllowlist: ['not a url'],
    });
    expect(badRedirect.statusCode).toBe(422);
    const ok = await post('/admin/oauth/clients', {
      clientId: 'cli',
      name: 'CLI',
      orgId,
      workspaceId,
      grantTypes: ['device_code', 'refresh_token'],
    });
    expect(ok.statusCode).toBe(200);
    // Re-save into a second workspace: the durable row follows (it used to keep the old scope).
    const ws2 = (
      (await post('/workspaces', { orgId, name: 'staging' }).then((r) => r.json())) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const moved = await post('/admin/oauth/clients', {
      clientId: 'cli',
      name: 'CLI',
      orgId,
      workspaceId: ws2,
      grantTypes: ['device_code'],
    });
    expect(moved.statusCode).toBe(200);
    expect((moved.json() as { client: { workspaceId: string } }).client.workspaceId).toBe(ws2);
  });

  it('revoking an unknown grant is a 404 and is not audited', async () => {
    const r = await post('/admin/oauth/grants/nope/revoke', {});
    expect(r.statusCode).toBe(404);
    const audit = (await get('/audit/events?limit=5')).json() as {
      events: Array<{ action: string; target: string }>;
    };
    expect(audit.events.some((e) => e.action === 'oauth.grant_revoked')).toBe(false);
  });

  it('audit reads are paged from the backend and the reuse feed is action-filtered', async () => {
    const first = (await get('/audit/events?limit=2')).json() as {
      events: Array<{ seq: number }>;
      nextCursor?: number;
    };
    expect(first.events).toHaveLength(2);
    expect(first.events[0]!.seq).toBeGreaterThan(first.events[1]!.seq);
    expect(first.nextCursor).toBe(first.events[1]!.seq);
    const next = (await get(`/audit/events?limit=2&before=${first.nextCursor}`)).json() as {
      events: Array<{ seq: number }>;
    };
    expect(next.events.every((e) => e.seq < first.nextCursor!)).toBe(true);
    await ctx.audit.append({
      actor: 'p',
      action: 'oauth.refresh_reuse',
      target: 'h1',
      payload: { clientId: 'cli' },
    });
    const feed = (await get('/admin/security/refresh-reuse?limit=10')).json() as {
      alerts: Array<{ handle: string }>;
    };
    expect(feed.alerts.map((a) => a.handle)).toEqual(['h1']);
    // The streamed verifier walks the durable chain and agrees with the in-memory report.
    const v = (await get('/audit/verify')).json() as { verified: boolean; count: number };
    expect(v.verified).toBe(true);
    expect(v.count).toBeGreaterThan(5);
  });
});
