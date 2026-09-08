import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresAdminSessionStore } from './admin-session-store';
import type { Database } from './db';
import {
  PostgresAuthCodeStore,
  PostgresGrantStore,
  PostgresOAuthClientStore,
} from './oauth-stores';
import * as schema from './schema';

let client: PGlite;
let db: Database;

async function applyMigrations(pg: PGlite): Promise<void> {
  const dir = fileURLToPath(new URL('../migrations', import.meta.url));
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

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await applyMigrations(client);
  // Seed the org + workspace the oauth_client FK references.
  await db.insert(schema.org).values({ id: ORG, name: 'Acme' });
  await db.insert(schema.workspace).values({ id: WS, orgId: ORG, name: 'prod' });
});
afterAll(async () => {
  await client.close();
});

const ORG = '11111111-1111-1111-1111-111111111111';
const WS = '22222222-2222-2222-2222-222222222222';

describe('durable OAuth + session stores (pglite)', () => {
  it('grant create/get/rotate CAS/revoke + secret-free list', async () => {
    const g = new PostgresGrantStore(db);
    await g.create({
      handle: 'h1',
      clientId: 'claude-code',
      principalId: 'user-1',
      displayName: 'Alice',
      orgId: ORG,
      workspaceId: WS,
      status: 'active',
      accessTokenHash: 'ah',
      accessTokenExpiresAt: Date.now() + 3600_000,
      refreshTokenHash: 'rh',
      prevRefreshTokenHash: null,
      refreshGeneration: 0,
      absoluteExpiresAt: Date.now() + 86_400_000,
    });
    const got = await g.get('h1');
    expect(got?.clientId).toBe('claude-code');

    // rotate is generation-guarded: wrong gen loses; correct gen wins.
    const next = {
      accessTokenHash: 'a2',
      accessTokenExpiresAt: Date.now() + 3600_000,
      refreshTokenHash: 'r2',
      prevRefreshTokenHash: 'rh',
      refreshGeneration: 1,
    };
    expect(await g.rotate('h1', 5, next)).toBe(false);
    expect(await g.rotate('h1', 0, next)).toBe(true);
    expect((await g.get('h1'))?.refreshGeneration).toBe(1);

    const list = await g.list();
    expect(list[0]?.handle).toBe('h1');
    expect(list[0]).not.toHaveProperty('accessTokenHash'); // secret-free

    await g.revoke('h1');
    expect((await g.get('h1'))?.status).toBe('revoked');
  });

  it('auth-code single-use consume (claim-first)', async () => {
    const c = new PostgresAuthCodeStore(db);
    await c.create({
      code: 'code1',
      clientId: 'claude-code',
      redirectUri: '/cb',
      codeChallenge: 'ch',
      principalId: 'u',
      displayName: 'U',
      orgId: ORG,
      workspaceId: WS,
      expiresAt: Date.now() + 60_000,
    });
    expect((await c.consume('code1'))?.code).toBe('code1');
    expect(await c.consume('code1')).toBeNull(); // consumed once
  });

  it('client registry upsert/list/delete', async () => {
    const cl = new PostgresOAuthClientStore(db);
    await cl.upsert({
      clientId: 'codex',
      name: 'Codex',
      orgId: ORG,
      workspaceId: WS,
      grantTypes: ['device_code'],
      redirectAllowlist: [],
      enabled: true,
    });
    await cl.upsert({
      clientId: 'codex',
      name: 'Codex CLI',
      orgId: ORG,
      workspaceId: WS,
      grantTypes: ['device_code', 'refresh_token'],
      redirectAllowlist: [],
      enabled: false,
    });
    const one = await cl.get('codex');
    expect(one?.name).toBe('Codex CLI');
    expect(one?.enabled).toBe(false);
    expect((await cl.list()).length).toBeGreaterThanOrEqual(1);
    expect(await cl.delete('codex')).toBe(true);
    expect(await cl.get('codex')).toBeNull();
  });

  it('admin session record/list/revoke (revocation survives without a record)', async () => {
    const s = new PostgresAdminSessionStore(db);
    await s.record({
      jti: '33333333-3333-3333-3333-333333333333',
      subject: 'admin@acme',
      source: 'oidc',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    const list = await s.list();
    expect(list.some((x) => x.subject === 'admin@acme')).toBe(true);
    expect(await s.isActive('33333333-3333-3333-3333-333333333333')).toBe(true);
    await s.revoke('33333333-3333-3333-3333-333333333333');
    expect(await s.isActive('33333333-3333-3333-3333-333333333333')).toBe(false);
    // Revoke a never-recorded jti still takes effect (upsert).
    await s.revoke('44444444-4444-4444-4444-444444444444');
    expect(await s.isActive('44444444-4444-4444-4444-444444444444')).toBe(false);
  });
});
