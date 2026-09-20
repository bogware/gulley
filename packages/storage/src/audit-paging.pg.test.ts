import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { AuditChainWalker } from '@gulley/pipeline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditHeadSeq,
  iterateAuditRows,
  PostgresAuditSink,
  readAuditPage,
  readAuditRows,
  readAuditRowsByAction,
} from './adapters';
import type { Database } from './db';
import { PostgresGrantStore, PostgresOAuthClientStore } from './oauth-stores';
import * as schema from './schema';
import { PostgresScimGroupStore } from './scim-group-store';
import { PostgresAdminUserStore } from './adapters';

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
});
afterAll(async () => {
  await client.close();
});

describe('audit chain readers — paged, tailed, aggregated, streamed', () => {
  it('head seq, keyset pages, action filter and the batched iterator agree with the full read', async () => {
    expect(await auditHeadSeq(db)).toBe(0);
    const sink = new PostgresAuditSink(db);
    for (let i = 1; i <= 25; i++) {
      await sink.append({
        actor: 'a',
        action: i % 5 === 0 ? 'oauth.refresh_reuse' : 'x.y',
        target: `t${i}`,
        payload: { i },
      });
    }
    expect(await auditHeadSeq(db)).toBe(25);

    const p1 = await readAuditPage(db, { limit: 10 });
    expect(p1.map((r) => r.seq)).toEqual([25, 24, 23, 22, 21, 20, 19, 18, 17, 16]);
    const p2 = await readAuditPage(db, { before: 16, limit: 10 });
    expect(p2[0]!.seq).toBe(15);
    expect(p2).toHaveLength(10);
    const p3 = await readAuditPage(db, { before: 6, limit: 10 });
    expect(p3.map((r) => r.seq)).toEqual([5, 4, 3, 2, 1]);

    const reuse = await readAuditRowsByAction(db, 'oauth.refresh_reuse', 3);
    expect(reuse.map((r) => r.seq)).toEqual([25, 20, 15]);

    const full = await readAuditRows(db);
    const streamed = [];
    for await (const r of iterateAuditRows(db, 7)) streamed.push(r);
    expect(streamed.map((r) => r.rowHash)).toEqual(full.map((r) => r.rowHash));

    const w = new AuditChainWalker();
    for await (const r of iterateAuditRows(db, 4)) w.push(r);
    expect(w.report()).toMatchObject({ verified: true, count: 25, firstSeq: 1, lastSeq: 25 });
  });
});

describe('OAuth stores — revoke reports existence; upsert follows tenancy', () => {
  it('revoke → false for an unknown handle, true once', async () => {
    const grants = new PostgresGrantStore(db);
    expect(await grants.revoke('nope')).toBe(false);
    const [org] = await db.insert(schema.org).values({ name: 'grant-org' }).returning();
    const [ws] = await db
      .insert(schema.workspace)
      .values({ orgId: org!.id, name: 'grant-ws' })
      .returning();
    await grants.create({
      handle: 'h1',
      clientId: 'c',
      principalId: 'p',
      displayName: 'P',
      orgId: org!.id,
      workspaceId: ws!.id,
      status: 'active',
      accessTokenHash: 'a',
      accessTokenExpiresAt: Date.now() + 1000,
      refreshTokenHash: 'r',
      prevRefreshTokenHash: null,
      refreshGeneration: 1,
      absoluteExpiresAt: Date.now() + 100_000,
    });
    expect(await grants.revoke('h1')).toBe(true);
    expect((await grants.get('h1'))?.status).toBe('revoked');
  });

  it('a re-saved client moves to the new org/workspace', async () => {
    const [org] = await db.insert(schema.org).values({ name: 'o' }).returning();
    const [ws1] = await db
      .insert(schema.workspace)
      .values({ orgId: org!.id, name: 'w1' })
      .returning();
    const [ws2] = await db
      .insert(schema.workspace)
      .values({ orgId: org!.id, name: 'w2' })
      .returning();
    const clients = new PostgresOAuthClientStore(db);
    const base = {
      clientId: 'cli',
      name: 'CLI',
      orgId: org!.id,
      grantTypes: ['device_code'],
      redirectAllowlist: [],
      enabled: true,
    };
    await clients.upsert({ ...base, workspaceId: ws1!.id });
    await clients.upsert({ ...base, workspaceId: ws2!.id });
    expect((await clients.get('cli'))?.workspaceId).toBe(ws2!.id);
  });
});

describe('SCIM group list — one member query for all groups', () => {
  it('returns every group with its members', async () => {
    const users = new PostgresAdminUserStore(db);
    const u1 = await users.upsertBySubject('u1', 'U1');
    const u2 = await users.upsertBySubject('u2', 'U2');
    const groups = new PostgresScimGroupStore(db, () => null);
    const a = await groups.create('a');
    const b = await groups.create('b');
    await groups.create('empty');
    await groups.addMember(a.id, u1.id, 'a');
    await groups.addMember(a.id, u2.id, 'a');
    await groups.addMember(b.id, u2.id, 'b');
    const all = await groups.list();
    const byName = Object.fromEntries(all.map((g) => [g.displayName, g.members.sort()]));
    expect(byName['a']).toEqual([u1.id, u2.id].sort());
    expect(byName['b']).toEqual([u2.id]);
    expect(byName['empty']).toEqual([]);
  });
});
