import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PromptNameConflictError } from '@gulley/prompts';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db';
import { PostgresPromptRegistry } from './prompt-store';
import * as schema from './schema';
import { expectedSchemaMillis, schemaStatus, schemaStatusProbe } from './schema-status';

let client: PGlite;
let db: Database;
let workspaceId: string;

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
  const [org] = await db.insert(schema.org).values({ name: 'o' }).returning();
  const [ws] = await db.insert(schema.workspace).values({ orgId: org!.id, name: 'w' }).returning();
  workspaceId = ws!.id;
});
afterAll(async () => {
  await client.close();
});

describe('PostgresPromptRegistry', () => {
  const args = (body: string, by = 'admin', message?: string) => ({
    body,
    createdBy: by,
    ...(message !== undefined ? { message } : {}),
  });

  it('creates, versions, reads back and verifies a chain', async () => {
    const r = new PostgresPromptRegistry(db);
    const t = await r.create(workspaceId, 'greet', args('Hi {{name}}'));
    expect(t.versions).toHaveLength(1);
    expect(t.versions[0]).toMatchObject({ version: 1, prevHash: null, variables: ['name'] });
    await expect(r.create(workspaceId, 'greet', args('x'))).rejects.toThrow(
      PromptNameConflictError,
    );
    const v2 = (await r.addVersion(t.id, args('Hi {{name}} {{x}}', 'bob', 'add x')))!;
    expect(v2).toMatchObject({ version: 2, prevHash: t.versions[0]!.hash, message: 'add x' });
    expect((await r.head(t.id))?.version).toBe(2);
    expect((await r.version(t.id, 1))?.body).toBe('Hi {{name}}');
    expect((await r.getByName(workspaceId, 'greet'))?.id).toBe(t.id);
    expect(await r.verifyChain(t.id)).toEqual({ verified: true, count: 2 });
    expect(await r.addVersion('00000000-0000-4000-8000-000000000000', args('x'))).toBeUndefined();
  });

  it('detects tampering with a stored body, author or timestamp', async () => {
    const r = new PostgresPromptRegistry(db);
    const t = await r.create(workspaceId, 'tamper', args('one'));
    await r.addVersion(t.id, args('two'));
    await db.execute(
      sql`update prompt_version set created_by = 'mallory' where template_id = ${t.id} and version = 2`,
    );
    expect(await r.verifyChain(t.id)).toMatchObject({ verified: false, brokenAt: 2 });
  });

  it('lists secret-free summaries with heads, scoped by workspace', async () => {
    const r = new PostgresPromptRegistry(db);
    const summaries = await r.list([workspaceId]);
    const greet = summaries.find((s) => s.name === 'greet')!;
    expect(greet).toMatchObject({ latestVersion: 2 });
    expect(greet).not.toHaveProperty('body');
    expect(await r.list([])).toEqual([]);
    expect((await r.list('*')).length).toBeGreaterThanOrEqual(2);
  });

  it('concurrent appends serialize on the template row (no two versions share a prev hash)', async () => {
    const r = new PostgresPromptRegistry(db);
    const t = await r.create(workspaceId, 'race', args('base'));
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => r.addVersion(t.id, args(`v${i}`))),
    );
    expect(results.every(Boolean)).toBe(true);
    const full = (await r.get(t.id))!;
    expect(full.versions.map((v) => v.version)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await r.verifyChain(t.id)).toEqual({ verified: true, count: 6 });
  });

  it('deletes a template and its versions', async () => {
    const r = new PostgresPromptRegistry(db);
    const t = await r.create(workspaceId, 'gone', args('x'));
    expect(await r.delete(t.id)).toBe(true);
    expect(await r.get(t.id)).toBeUndefined();
    expect(await r.delete(t.id)).toBe(false);
  });
});

describe('schemaStatus probe', () => {
  it('reads this build’s journal', () => {
    const expected = expectedSchemaMillis();
    expect(expected).toBeGreaterThan(1_700_000_000_000);
    expect(expectedSchemaMillis('/nonexistent')).toBeNull();
  });

  it('reports never-migrated → behind → current → ahead', async () => {
    const expected = expectedSchemaMillis()!;
    expect(await schemaStatus(db, expected)).toMatchObject({ ok: false, applied: null });
    await db.execute(sql`create schema if not exists drizzle`);
    await db.execute(
      sql`create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`,
    );
    expect(await schemaStatus(db, expected)).toMatchObject({ ok: false, applied: null });
    await db.execute(
      sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('a', ${expected - 5})`,
    );
    expect(await schemaStatus(db, expected)).toMatchObject({ ok: false, applied: expected - 5 });
    await db.execute(
      sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('b', ${expected})`,
    );
    expect(await schemaStatus(db, expected)).toEqual({ ok: true, applied: expected, expected });
    expect(await schemaStatus(db, null)).toMatchObject({
      ok: true,
      reason: expect.stringMatching(/journal/),
    });
    await db.execute(
      sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('c', ${expected + 5})`,
    );
    expect(await schemaStatus(db, expected)).toMatchObject({
      ok: true,
      reason: expect.stringMatching(/ahead/),
    });
  });

  it('the memoized probe caches within its ttl and keeps the last answer on a query error', async () => {
    const expected = expectedSchemaMillis()!;
    const probe = schemaStatusProbe(db, { ttlMs: 60_000, expected: expected + 5 });
    const first = await probe();
    expect(first.ok).toBe(true);
    await db.execute(sql`drop table drizzle.__drizzle_migrations`);
    expect(await probe()).toBe(first); // cached
    const fresh = schemaStatusProbe(db, { ttlMs: 0, expected });
    expect((await fresh()).ok).toBe(false); // table gone → never applied
  });
});
