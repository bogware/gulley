import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db';
import * as schema from './schema';
import { PostgresTenancyStore } from './tenancy-store';

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

describe('PostgresTenancyStore', () => {
  it('writes through with the caller-generated ids, lists back, and cascades org deletes', async () => {
    const store = new PostgresTenancyStore(db);
    const orgId = randomUUID();
    const wsId = randomUUID();
    const at = new Date('2026-09-14T00:00:00Z');
    await store.insertOrg({ id: orgId, name: 'Acme', createdAt: at });
    await store.insertOrg({ id: orgId, name: 'Acme', createdAt: at }); // idempotent
    await store.insertWorkspace({ id: wsId, orgId, name: 'prod', createdAt: at });

    expect((await store.listOrgs()).map((o) => o.id)).toContain(orgId);
    const ws = (await store.listWorkspaces()).find((w) => w.id === wsId);
    expect(ws).toMatchObject({ orgId, name: 'prod' });

    // A referencing row (an OAuth client) is satisfied by the durable tenancy.
    await db.insert(schema.oauthClient).values({
      clientId: 'claude-code',
      name: 'Claude Code',
      orgId,
      workspaceId: wsId,
    });

    expect(await store.deleteWorkspace(randomUUID())).toBe(false);
    expect(await store.deleteOrg(orgId)).toBe(true);
    expect((await store.listWorkspaces()).some((w) => w.id === wsId)).toBe(false);
    expect((await db.select().from(schema.oauthClient)).length).toBe(0); // cascaded
  });
});
