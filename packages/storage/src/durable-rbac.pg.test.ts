import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresAdminUserStore, PostgresMembershipStore } from './adapters';
import type { Database } from './db';
import * as schema from './schema';
import { org } from './schema';

let client: PGlite;
let db: Database;
let users: PostgresAdminUserStore;
let memberships: PostgresMembershipStore;
let orgA: string;
let orgB: string;

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
  users = new PostgresAdminUserStore(db);
  memberships = new PostgresMembershipStore(db);
  const [a] = await db.insert(org).values({ name: 'Acme' }).returning({ id: org.id });
  const [b] = await db.insert(org).values({ name: 'Beta' }).returning({ id: org.id });
  orgA = a!.id;
  orgB = b!.id;
});

afterAll(async () => {
  await client.close();
});

describe('PostgresAdminUserStore', () => {
  it('upserts idempotently by subject', async () => {
    const u1 = await users.upsertBySubject('alice@corp', 'Alice');
    const u2 = await users.upsertBySubject('alice@corp', 'Alice Renamed', 'alice@corp.com');
    expect(u2.id).toBe(u1.id); // same row
    expect(u2.displayName).toBe('Alice Renamed');
    expect(u2.email).toBe('alice@corp.com');
    expect((await users.getBySubject('alice@corp'))?.id).toBe(u1.id);
  });
});

describe('PostgresMembershipStore', () => {
  it('grants, resolves by subject (join), lists scoped, and cascades on user delete', async () => {
    const alice = await users.upsertBySubject('grant-alice', 'Alice');
    await memberships.create(alice.id, 'owner', orgA);
    await memberships.create(alice.id, 'viewer', orgB);

    // membershipsForSubject joins admin_user → the effective grants for that subject.
    const bySubject = await memberships.membershipsForSubject('grant-alice');
    expect(bySubject.map((m) => `${m.role}@${m.orgId}`).sort()).toEqual([
      `owner@${orgA}`,
      `viewer@${orgB}`,
    ]);

    // Scoped list: only orgA-visible grants.
    const scopedA = await memberships.list([orgA]);
    expect(scopedA.every((m) => m.orgId === orgA)).toBe(true);
    expect(scopedA.some((m) => m.role === 'owner')).toBe(true);
    // Empty scope → nothing (no RBAC-leaky fall-through).
    expect(await memberships.list([])).toEqual([]);

    // Deleting the user cascades to its membership rows.
    await users.delete(alice.id);
    expect(await memberships.membershipsForSubject('grant-alice')).toEqual([]);
  });

  it('revokes a single grant by id', async () => {
    const bob = await users.upsertBySubject('grant-bob', 'Bob');
    const m = await memberships.create(bob.id, 'editor', orgA);
    expect(await memberships.delete(m.id)).toBe(true);
    expect(await memberships.membershipsForSubject('grant-bob')).toEqual([]);
    expect(await memberships.delete(m.id)).toBe(false); // already gone
  });
});
