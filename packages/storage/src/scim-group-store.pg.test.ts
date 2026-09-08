import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db';
import { PostgresAdminUserStore, PostgresMembershipStore } from './adapters';
import { PostgresScimGroupStore } from './scim-group-store';
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
});
afterAll(async () => {
  await client.close();
});

// displayName "gulley-editors" grants the editor role platform-wide.
const roleFor = (dn: string) => (dn === 'gulley-editors' ? { role: 'editor', orgId: null } : null);

describe('PostgresScimGroupStore', () => {
  it('grants the mapped role on member add and revokes exactly it on remove', async () => {
    const users = new PostgresAdminUserStore(db);
    const memberships = new PostgresMembershipStore(db);
    const groups = new PostgresScimGroupStore(db, roleFor);

    const alice = await users.upsertBySubject('alice@corp', 'Alice');
    const g = await groups.create('gulley-editors', 'ext-1');

    await groups.addMember(g.id, alice.id, 'gulley-editors');
    const mine = await memberships.listByUser(alice.id);
    expect(mine.map((m) => m.role)).toEqual(['editor']);
    expect(mine[0]!.orgId).toBeNull(); // platform-wide

    const got = await groups.get(g.id);
    expect(got?.members).toEqual([alice.id]);

    // idempotent add — no duplicate grant
    await groups.addMember(g.id, alice.id, 'gulley-editors');
    expect((await memberships.listByUser(alice.id)).length).toBe(1);

    await groups.removeMember(g.id, alice.id);
    expect(await memberships.listByUser(alice.id)).toEqual([]);
    expect((await groups.get(g.id))?.members).toEqual([]);
  });

  it('tracks members of an unmapped group but grants nothing', async () => {
    const users = new PostgresAdminUserStore(db);
    const memberships = new PostgresMembershipStore(db);
    const groups = new PostgresScimGroupStore(db, roleFor);

    const bob = await users.upsertBySubject('bob@corp', 'Bob');
    const g = await groups.create('some-unmapped-group');
    await groups.addMember(g.id, bob.id, 'some-unmapped-group');

    expect((await groups.get(g.id))?.members).toEqual([bob.id]);
    expect(await memberships.listByUser(bob.id)).toEqual([]); // no role granted
  });

  it('deleting a group revokes all of its role grants', async () => {
    const users = new PostgresAdminUserStore(db);
    const memberships = new PostgresMembershipStore(db);
    const groups = new PostgresScimGroupStore(db, roleFor);

    const carol = await users.upsertBySubject('carol@corp', 'Carol');
    const g = await groups.create('gulley-editors-2');
    // map this one too by using the mapped displayName for the grant
    await groups.addMember(g.id, carol.id, 'gulley-editors');
    expect((await memberships.listByUser(carol.id)).length).toBe(1);

    expect(await groups.delete(g.id)).toBe(true);
    expect(await memberships.listByUser(carol.id)).toEqual([]);
    expect(await groups.get(g.id)).toBeUndefined();
    // group_member rows are gone with the cascade
    const left = await db
      .select()
      .from(schema.scimGroupMember)
      .where(eq(schema.scimGroupMember.groupId, g.id));
    expect(left).toEqual([]);
  });
});
