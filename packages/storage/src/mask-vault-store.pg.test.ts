import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db';
import { PostgresMaskVaultStore } from './mask-vault-store';
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

const WS = '11111111-1111-1111-1111-111111111111';
const cipher = {
  v: 1,
  keyClass: 'mask-vault',
  iv: 'aa',
  tag: 'bb',
  ciphertext: 'cc',
  wrappedKey: 'dd',
};

describe('PostgresMaskVaultStore (real SQL via pglite)', () => {
  it('put/get round-trips the ciphertext jsonb and metadata', async () => {
    const store = new PostgresMaskVaultStore(db);
    await store.put({
      requestId: 'req_1',
      direction: 'output',
      workspaceId: WS,
      orgId: null,
      ciphertext: cipher,
      tokenCount: 2,
      ttlSeconds: 3600,
    });
    const v = await store.get('req_1', 'output');
    expect(v).toMatchObject({
      requestId: 'req_1',
      direction: 'output',
      workspaceId: WS,
      tokenCount: 2,
    });
    expect(v?.ciphertext).toEqual(cipher);
    expect(await store.get('req_1', 'input')).toBeUndefined(); // different direction
  });

  it('lists all directions for a request', async () => {
    const store = new PostgresMaskVaultStore(db);
    await store.put({
      requestId: 'req_2',
      direction: 'input',
      workspaceId: WS,
      orgId: null,
      ciphertext: cipher,
      tokenCount: 1,
      ttlSeconds: 3600,
    });
    await store.put({
      requestId: 'req_2',
      direction: 'output',
      workspaceId: WS,
      orgId: null,
      ciphertext: cipher,
      tokenCount: 1,
      ttlSeconds: 3600,
    });
    const rows = await store.list('req_2');
    expect(rows.map((r) => r.direction).sort()).toEqual(['input', 'output']);
  });

  it('upserts on (request_id, direction) conflict', async () => {
    const store = new PostgresMaskVaultStore(db);
    await store.put({
      requestId: 'req_3',
      direction: 'output',
      workspaceId: WS,
      orgId: null,
      ciphertext: cipher,
      tokenCount: 1,
      ttlSeconds: 3600,
    });
    await store.put({
      requestId: 'req_3',
      direction: 'output',
      workspaceId: WS,
      orgId: null,
      ciphertext: { ...cipher, ciphertext: 'zz' },
      tokenCount: 5,
      ttlSeconds: 3600,
    });
    const v = await store.get('req_3', 'output');
    expect(v?.tokenCount).toBe(5);
    expect((v?.ciphertext as { ciphertext: string }).ciphertext).toBe('zz');
  });

  it('hides expired rows and sweeps them', async () => {
    const store = new PostgresMaskVaultStore(db);
    await store.put({
      requestId: 'req_exp',
      direction: 'output',
      workspaceId: WS,
      orgId: null,
      ciphertext: cipher,
      tokenCount: 1,
      ttlSeconds: -1,
    });
    expect(await store.get('req_exp', 'output')).toBeUndefined(); // past expiry → invisible
    const swept = await store.sweepExpired(new Date());
    expect(swept).toBeGreaterThanOrEqual(1);
  });
});
