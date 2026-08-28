import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresKeyAdminStore, PostgresKeyStore } from './adapters';
import type { Database } from './db';
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
      if (/::vector/i.test(stmt)) continue; // pglite has no ::vector cast (0012 backfill)
      stmt = stmt.replace(/vector\(\d+\)/gi, 'text');
      await pg.exec(stmt);
    }
  }
}

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WS = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await applyMigrations(client);
  await db.insert(schema.org).values({ id: ORG, name: 'Acme' });
  await db.insert(schema.workspace).values({ id: WS, orgId: ORG, name: 'prod' });
});

afterAll(async () => {
  await client.close();
});

describe('PostgresKeyAdminStore (real SQL via pglite)', () => {
  it('mints a resolvable key, lists it, revokes it, and rotates the secret', async () => {
    const admin = new PostgresKeyAdminStore(db, 'pepper');
    const gw = new PostgresKeyStore(db);

    const minted = await admin.mint({ workspaceId: WS, orgId: ORG, name: 'ci' });
    expect(minted.token).toContain(minted.keyPrefix); // token embeds the prefix
    // The gateway resolves the minted key (not disabled).
    const resolved = await gw.findByPrefix(minted.keyPrefix);
    expect(resolved?.disabled).toBe(false);
    expect(resolved?.orgId).toBe(ORG);

    // list is org-scoped.
    expect((await admin.list([ORG])).map((k) => k.id)).toContain(minted.id);
    expect(await admin.list(['00000000-0000-0000-0000-000000000000'])).toEqual([]);

    // Revoke → the gateway now sees disabled + an epoch bump.
    const disabled = await admin.disable(minted.id);
    expect(disabled?.disabled).toBe(true);
    const afterRevoke = await gw.findByPrefix(minted.keyPrefix);
    expect(afterRevoke?.disabled).toBe(true);
    expect(afterRevoke?.epoch).toBe(1);

    // Rotate → new secret under a new prefix; the old prefix no longer resolves.
    const rotated = await admin.rotate(minted.id);
    expect(rotated?.keyPrefix).not.toBe(minted.keyPrefix);
    expect(await gw.findByPrefix(minted.keyPrefix)).toBeNull(); // old prefix gone
    const byNew = await gw.findByPrefix(rotated!.keyPrefix);
    expect(byNew?.id).toBe(minted.id); // same row, new secret
    expect(byNew?.epoch).toBe(2);

    expect(await admin.disable('99999999-9999-9999-9999-999999999999')).toBeUndefined();
  });
});
