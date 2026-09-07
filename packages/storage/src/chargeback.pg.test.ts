import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chargebackReport } from './adapters';
import type { Database } from './db';
import * as schema from './schema';
import { spendLedger } from './schema';

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

const WS = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await applyMigrations(client);
  const base = { principalId: 'p', provider: 'anthropic', status: 'ok', createdAt: new Date() };
  await db.insert(spendLedger).values([
    {
      ...base,
      requestId: 'r1',
      workspaceId: WS,
      model: 'opus',
      inputTokens: 100,
      outputTokens: 50,
      costMicroUsd: 5000,
      cacheSavedMicroUsd: 1000,
      attributes: { repo: 'acme/api', dev: 'alice' },
    },
    {
      ...base,
      requestId: 'r2',
      workspaceId: WS,
      model: 'sonnet',
      inputTokens: 40,
      outputTokens: 20,
      costMicroUsd: 3000,
      cacheSavedMicroUsd: 500,
      attributes: { repo: 'acme/api', dev: 'bob' },
    },
    {
      ...base,
      requestId: 'r3',
      workspaceId: WS,
      model: 'opus',
      inputTokens: 200,
      outputTokens: 90,
      costMicroUsd: 9000,
      cacheSavedMicroUsd: 0,
      attributes: { repo: 'acme/web' },
    },
    // A row in a workspace outside the caller's scope — must be excluded.
    {
      ...base,
      requestId: 'r4',
      workspaceId: OTHER,
      model: 'opus',
      costMicroUsd: 99000,
      attributes: { repo: 'secret/repo' },
    },
  ]);
});

afterAll(async () => {
  await client.close();
});

describe('chargebackReport', () => {
  it('groups durable spend by an attribution tag, highest cost first, scoped', async () => {
    const rows = await chargebackReport(db, { groupBy: 'attr:repo', workspaceIds: [WS] });
    expect(rows).toEqual([
      {
        key: 'acme/web',
        requests: 1,
        inputTokens: 200,
        outputTokens: 90,
        costMicroUsd: 9000,
        cacheSavedMicroUsd: 0,
      },
      {
        key: 'acme/api',
        requests: 2,
        inputTokens: 140,
        outputTokens: 70,
        costMicroUsd: 8000,
        cacheSavedMicroUsd: 1500,
      },
    ]);
  });

  it('groups by model and never leaks an out-of-scope workspace', async () => {
    const rows = await chargebackReport(db, { groupBy: 'model', workspaceIds: [WS] });
    const opus = rows.find((r) => r.key === 'opus');
    expect(opus?.costMicroUsd).toBe(14000); // r1 + r3, NOT r4 (other workspace)
  });

  it('returns nothing for an empty scope (no RBAC-leaky fall-through)', async () => {
    expect(await chargebackReport(db, { groupBy: 'model', workspaceIds: [] })).toEqual([]);
  });
});
