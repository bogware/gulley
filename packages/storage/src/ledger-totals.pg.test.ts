import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ledgerSpendTotals } from './adapters';
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
  const base = { principalId: 'p', status: 'ok', createdAt: new Date() };
  await db.insert(spendLedger).values([
    {
      ...base,
      requestId: 'r1',
      workspaceId: WS,
      provider: 'anthropic',
      model: 'opus',
      inputTokens: 100,
      outputTokens: 50,
      costMicroUsd: 5000,
    },
    {
      ...base,
      requestId: 'r2',
      workspaceId: WS,
      provider: 'anthropic',
      model: 'opus',
      inputTokens: 200,
      outputTokens: 90,
      costMicroUsd: 9000,
    },
    {
      ...base,
      requestId: 'r3',
      workspaceId: WS,
      provider: 'anthropic',
      model: 'sonnet',
      inputTokens: 40,
      outputTokens: 20,
      costMicroUsd: 3000,
    },
    {
      ...base,
      requestId: 'r4',
      workspaceId: WS,
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 10,
      outputTokens: 5,
      costMicroUsd: 1200,
    },
    // Out-of-scope workspace — must be excluded when scoped to [WS].
    {
      ...base,
      requestId: 'r5',
      workspaceId: OTHER,
      provider: 'anthropic',
      model: 'opus',
      costMicroUsd: 99000,
    },
  ]);
});

afterAll(async () => {
  await client.close();
});

describe('ledgerSpendTotals', () => {
  it('aggregates per (provider, model), scoped to the caller workspaces', async () => {
    const rows = await ledgerSpendTotals(db, { workspaceIds: [WS] });
    const opus = rows.find((r) => r.provider === 'anthropic' && r.model === 'opus')!;
    expect(opus).toMatchObject({
      requests: 2,
      inputTokens: 300,
      outputTokens: 140,
      costMicroUsd: 14000,
    });
    const sonnet = rows.find((r) => r.provider === 'anthropic' && r.model === 'sonnet')!;
    expect(sonnet.costMicroUsd).toBe(3000);
    const gpt = rows.find((r) => r.provider === 'openai' && r.model === 'gpt-4o')!;
    expect(gpt.costMicroUsd).toBe(1200);
    // The out-of-scope workspace's 99000 is never included.
    const anthropicTotal = rows
      .filter((r) => r.provider === 'anthropic')
      .reduce((n, r) => n + r.costMicroUsd, 0);
    expect(anthropicTotal).toBe(17000); // r1+r2+r3, NOT r5
  });

  it('returns nothing for an empty scope (no RBAC-leaky fall-through)', async () => {
    expect(await ledgerSpendTotals(db, { workspaceIds: [] })).toEqual([]);
  });
});
