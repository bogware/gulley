import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { type ConfigDocument, contentHash } from '@gulley/config';
import { secretRef } from '@gulley/core';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db';
import {
  PostgresConfigBackend,
  PostgresConfigStore,
  PostgresConfigVersionStore,
} from './config-store';
import * as schema from './schema';

// A real Postgres engine (pglite/WASM) in-process — no Docker — so the actual SQL
// of PostgresConfigBackend + PostgresConfigVersionStore is verified in CI, not
// just the in-memory algorithm. The migrations (incl. pgvector) are applied.
const admin = { subject: 'admin' } as never;
const allow = { can: async () => true } as never;
const ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:anthropic-live';

const doc = (over: Record<string, unknown> = {}): ConfigDocument => ({
  apiVersion: 'gulley/v1',
  orgs: [
    {
      name: 'Acme',
      workspaces: [
        {
          name: 'prod',
          providers: [
            {
              kind: 'anthropic',
              baseUrl: 'https://api.anthropic.com',
              enabled: true,
              credential: secretRef(ARN, 'v1'),
            },
          ],
          routes: [{ name: 'default', config: { strategy: 'single' } }],
          policies: [],
          budgets: [
            { name: 'monthly', config: { capMicroUsd: 1_000_000, periodSeconds: 2_592_000 } },
          ],
          rateLimits: [],
          guardrails: [],
          modelAliases: [],
          virtualKeys: [],
          ...over,
        },
      ],
    },
  ],
});

let client: PGlite;
let db: Database;

/** Apply the migrations, sanitizing the pgvector-only bits (pglite has no vector
 *  extension bundled and the config store never touches those tables). */
async function applyMigrations(pg: PGlite): Promise<void> {
  const dir = fileURLToPath(new URL('../migrations', import.meta.url));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    const raw = readFileSync(`${dir}/${f}`, 'utf8');
    for (let stmt of raw.split('--> statement-breakpoint')) {
      stmt = stmt.trim();
      if (!stmt) continue;
      if (/create extension.*vector/i.test(stmt)) continue; // no pgvector in pglite
      if (/using hnsw/i.test(stmt)) continue; // vector index — not needed here
      if (/::vector/i.test(stmt)) continue; // pglite has no ::vector cast (0012 backfill)
      stmt = stmt.replace(/vector\(\d+\)/gi, 'text'); // embedding col → text
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

describe('PostgresConfigStore (real SQL via pglite)', () => {
  it('reconciles a document to Postgres and round-trips it (content hash stable)', async () => {
    const store = new PostgresConfigStore(db);
    const d = doc();
    await store.reconcile(d, { admin, access: allow });
    const exported = await store.exportDocument('*');
    expect(contentHash(exported)).toBe(contentHash(d));
    // Credential persisted as an ARN reference; named budget round-trips.
    const ws = exported.orgs[0]?.workspaces[0];
    expect(ws?.providers[0]?.credential?.secretArn).toBe(ARN);
    expect(ws?.budgets[0]).toMatchObject({ name: 'monthly', config: { capMicroUsd: 1_000_000 } });
  });

  it('upserts + prunes + clears a dropped credential on a second apply', async () => {
    const store = new PostgresConfigStore(db);
    await store.reconcile(doc(), { admin, access: allow });
    await store.reconcile(
      doc({
        providers: [{ kind: 'anthropic', baseUrl: 'https://api.anthropic.com', enabled: true }], // no credential
        routes: [{ name: 'default', config: { strategy: 'fallback' } }],
        guardrails: [{ name: 'g', config: { action: 'block' } }],
      }),
      { admin, access: allow },
    );
    const ws = (await store.exportDocument('*')).orgs[0]?.workspaces[0];
    expect(ws?.providers[0]?.credential).toBeUndefined(); // credential cleared
    expect(ws?.routes[0]?.config).toEqual({ strategy: 'fallback' }); // updated
    expect(ws?.guardrails.some((g) => g.name === 'g')).toBe(true); // created
  });

  it('version store: currentVersion / tryReserve gate / append (no placeholder rows)', async () => {
    const versions = new PostgresConfigVersionStore(db);
    const v0 = await versions.currentVersion();
    expect(await versions.tryReserve(v0 + 5)).toBeNull(); // stale base → null
    const reserved = await versions.tryReserve(v0);
    expect(reserved).toBe(v0 + 1);
    // tryReserve wrote NOTHING — current() is unchanged until append.
    expect(await versions.currentVersion()).toBe(v0);
    await versions.append({
      version: reserved as number,
      contentHash: 'h',
      yaml: 'y',
      actor: 'admin',
      summary: { added: [], removed: [], changed: [] },
      auditSeq: 1,
      createdAt: new Date(0).toISOString(),
    });
    expect(await versions.currentVersion()).toBe(v0 + 1);
    expect((await versions.current())?.contentHash).toBe('h'); // never a blank placeholder
  });

  it('runInTransaction rolls back a partial write on a throw (real SQL)', async () => {
    const store = new PostgresConfigStore(db);
    await store.reconcile(doc(), { admin, access: allow }); // seed a workspace
    const backend = new PostgresConfigBackend(db);
    const org = (await backend.listOrgs())[0]!;
    const ws = (await backend.listWorkspaces(org.id))[0]!;
    const before = (await backend.listEntities('guardrail', ws.id)).length;

    await expect(
      backend.runInTransaction(async (tx) => {
        await tx.createEntity('guardrail', ws.id, 'temp', { a: 1 });
        throw new Error('boom');
      }),
    ).rejects.toThrow();

    // The insert was rolled back with the transaction — nothing persisted.
    expect((await backend.listEntities('guardrail', ws.id)).length).toBe(before);
  });
});
