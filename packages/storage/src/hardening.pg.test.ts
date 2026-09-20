import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { InMemoryAesCipher } from '@gulley/crypto';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresAdminUserStore, PostgresLedger, PostgresMembershipStore } from './adapters';
import { PostgresAdminSessionStore } from './admin-session-store';
import { PostgresExactCache } from './cache-adapters';
import type { Database } from './db';
import { PostgresScimGroupStore } from './scim-group-store';
import * as schema from './schema';
import { PostgresSubjectKeyStore } from './subject-key-store';

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

const cached = () => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from('{"ok":true}'),
  streamed: false,
  model: 'claude',
  inputTokens: 1,
  outputTokens: 1,
  createdAtMs: 0,
});

describe('storage hardening (real SQL via pglite)', () => {
  it('sweeps expired cache rows in bounded batches and reports the real row count', async () => {
    const cache = new PostgresExactCache(db);
    for (let i = 0; i < 7; i++) await cache.set(`sweep:stale${i}`, cached(), -300);
    for (let i = 0; i < 3; i++) await cache.set(`sweep:live${i}`, cached(), 300);
    const first = await cache.sweepExpiredDetailed(new Date(), { batchSize: 2 });
    expect(first.removed).toBe(7); // 4 batches: 2+2+2+1
    expect(first.skipped).toBe(false);
    expect(await cache.sweepExpired()).toBe(0);
    for (let i = 0; i < 3; i++) expect(await cache.get(`sweep:live${i}`)).not.toBeNull();
  });

  it('a re-stored cache key refreshes every value column, not just the body', async () => {
    const cache = new PostgresExactCache(db);
    await cache.set('upsert:k', { ...cached(), headers: { 'x-v': 'a' }, outputTokens: 5 }, 300);
    await cache.set('upsert:k', { ...cached(), headers: { 'x-v': 'b' }, outputTokens: 9 }, 300);
    const got = await cache.get('upsert:k');
    expect(got?.headers).toEqual({ 'x-v': 'b' });
    expect(got?.outputTokens).toBe(9);
  });

  it('TRUNCATE on the hash-chained tables is refused (append-only, statement-level)', async () => {
    // Drizzle wraps the driver error ("Failed query: ...") and keeps the trigger's
    // RAISE text on `cause`; assert on both so the failure is provably the trigger.
    const refusal = async (q: ReturnType<typeof sql>): Promise<string> => {
      const e = await db.execute(q).then(
        () => undefined,
        (err: unknown) => err as Error & { cause?: Error },
      );
      expect(e).toBeDefined();
      return `${e!.message} ${e!.cause?.message ?? ''}`;
    };
    expect(await refusal(sql`truncate audit_log`)).toMatch(/append-only/);
    expect(await refusal(sql`truncate config_version`)).toMatch(/append-only/);
  });

  it('the ledger is idempotent on request_id (a duplicate write never double-charges)', async () => {
    const ledger = new PostgresLedger(db);
    const entry = {
      requestId: 'req_dup_1',
      principalId: 'vk_1',
      orgId: '00000000-0000-4000-8000-000000000001',
      workspaceId: '00000000-0000-4000-8000-000000000002',
      provider: 'anthropic',
      model: 'claude',
      cost: {
        provider: 'anthropic',
        model: 'claude',
        priced: true,
        inputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 5,
        totalInputTokens: 10,
        inputUsd: 0,
        cacheReadUsd: 0,
        cacheWriteUsd: 0,
        outputUsd: 0,
        totalUsd: 0.001,
        cacheSavedUsd: 0,
      },
      costMicroUsd: 1000,
      status: 'ok' as const,
      createdAt: new Date(),
    };
    await ledger.record(entry);
    await ledger.record(entry);
    const rows = await db
      .select()
      .from(schema.spendLedger)
      .where(sql`${schema.spendLedger.requestId} = 'req_dup_1'`);
    expect(rows).toHaveLength(1);
  });

  it('concurrent first-use of a subject key converges on ONE persisted key', async () => {
    const store = new PostgresSubjectKeyStore(db, new InMemoryAesCipher());
    const [a, b, c] = await Promise.all([
      store.getOrCreate('subject-race'),
      store.getOrCreate('subject-race'),
      store.getOrCreate('subject-race'),
    ]);
    const persisted = await store.get('subject-race');
    expect(persisted).toBeDefined();
    for (const k of [a, b, c]) expect(k.equals(persisted!)).toBe(true);
  });

  it('a retried SCIM member add grants exactly one membership (transactional, index-claimed)', async () => {
    const users = new PostgresAdminUserStore(db);
    const memberships = new PostgresMembershipStore(db);
    const groups = new PostgresScimGroupStore(db, (dn) =>
      dn === 'hard-editors' ? { role: 'editor', orgId: null } : null,
    );
    const bob = await users.upsertBySubject('bob@corp', 'Bob');
    const g = await groups.create('hard-editors', 'ext-h');
    await Promise.all([
      groups.addMember(g.id, bob.id, 'hard-editors'),
      groups.addMember(g.id, bob.id, 'hard-editors'),
    ]);
    await groups.addMember(g.id, bob.id, 'hard-editors');
    expect((await memberships.listByUser(bob.id)).map((m) => m.role)).toEqual(['editor']);
    await groups.removeMember(g.id, bob.id);
    expect(await memberships.listByUser(bob.id)).toEqual([]);
  });

  it('revokeBySubject revokes every live session of a subject and nobody else', async () => {
    const sessions = new PostgresAdminSessionStore(db);
    const mk = async (jti: string, subject: string) =>
      sessions.record({
        jti,
        subject,
        source: 'oidc',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    await mk('11111111-1111-4111-8111-111111111111', 'gone@corp');
    await mk('22222222-2222-4222-8222-222222222222', 'gone@corp');
    await mk('33333333-3333-4333-8333-333333333333', 'stays@corp');
    expect(await sessions.revokeBySubject('gone@corp')).toBe(2);
    expect(await sessions.isActive('11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(await sessions.isActive('22222222-2222-4222-8222-222222222222')).toBe(false);
    expect(await sessions.isActive('33333333-3333-4333-8333-333333333333')).toBe(true);
    expect(await sessions.revokeBySubject('gone@corp')).toBe(0);
  });
});
