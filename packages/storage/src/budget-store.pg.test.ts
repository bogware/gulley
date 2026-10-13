import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  budgetConfigToColumns,
  budgetRowToConfig,
  createBudgetCapResolver,
  deleteOrgBudget,
  getOrgBudget,
  loadBudgetHealData,
  orgBudgetProblem,
  upsertOrgBudget,
} from './budget-store';
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
      if (/::vector/i.test(stmt)) continue;
      stmt = stmt.replace(/vector\(\d+\)/gi, 'text');
      await pg.exec(stmt);
    }
  }
}

const ORG = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const WS2 = '33333333-3333-4333-8333-333333333333';

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await applyMigrations(client);
  await db.insert(schema.org).values({ id: ORG, name: 'Acme' });
  await db.insert(schema.workspace).values([
    { id: WS, orgId: ORG, name: 'prod' },
    { id: WS2, orgId: ORG, name: 'dev' },
  ]);
});

afterAll(async () => {
  await client.close();
});

describe('budget rows ↔ entity config', () => {
  it('maps the legacy shape, the windows shape and every scope kind to columns and back', () => {
    const legacy = budgetConfigToColumns({ capMicroUsd: 5_000_000, periodSeconds: 86_400 }, WS);
    expect(legacy.columns).toEqual({
      scopeKind: 'workspace',
      scopeId: WS,
      capMicroUsd: 5_000_000,
      periodSeconds: 86_400,
      windows: null,
    });
    const keyDefault = budgetConfigToColumns(
      { scope: { kind: 'key' }, windows: [{ capMicroUsd: 10, period: 'daily' }] },
      WS,
    );
    expect(keyDefault.columns?.scopeKind).toBe('key');
    expect(keyDefault.columns?.scopeId).toBe('*');
    expect(keyDefault.columns?.windows).toEqual([{ capMicroUsd: 10, period: { kind: 'daily' } }]);
    expect(budgetConfigToColumns({ scope: { kind: 'org' }, capMicroUsd: 1 }, WS).problem).toMatch(
      /org/,
    );
    expect(
      budgetConfigToColumns({ scope: { kind: 'galaxy' }, capMicroUsd: 1 }, WS).problem,
    ).toMatch(/scope.kind/);
    expect(budgetConfigToColumns({ capMicroUsd: -1 }, WS).problem).toMatch(/positive/);
    // Round trip preserves the authored shape.
    expect(
      budgetRowToConfig({
        scopeKind: 'user',
        scopeId: 'alice',
        workspaceId: WS,
        capMicroUsd: 1,
        periodSeconds: null,
        windows: [{ capMicroUsd: 1, period: { kind: 'monthly' } }],
      }),
    ).toEqual({
      scope: { kind: 'user', id: 'alice' },
      windows: [{ capMicroUsd: 1, period: { kind: 'monthly' } }],
    });
    expect(
      budgetRowToConfig({
        scopeKind: 'workspace',
        scopeId: WS,
        workspaceId: WS,
        capMicroUsd: 7,
        periodSeconds: null,
        windows: null,
      }),
    ).toEqual({ capMicroUsd: 7 });
  });
});

describe('createBudgetCapResolver (pglite)', () => {
  it('resolves workspace, org, per-entity and default rows by scope string', async () => {
    await db.insert(schema.budget).values([
      {
        workspaceId: WS,
        name: 'ws',
        scopeKind: 'workspace',
        scopeId: WS,
        capMicroUsd: 100,
        periodSeconds: 3600,
      },
      {
        workspaceId: null,
        name: 'org',
        scopeKind: 'org',
        scopeId: ORG,
        capMicroUsd: 1_000,
        windows: [{ capMicroUsd: 1_000, period: { kind: 'monthly' } }],
      },
      {
        workspaceId: WS,
        name: 'keys',
        scopeKind: 'key',
        scopeId: '*',
        capMicroUsd: 10,
        windows: [{ capMicroUsd: 10, period: { kind: 'daily' } }],
      },
      {
        workspaceId: WS,
        name: 'vip-key',
        scopeKind: 'key',
        scopeId: 'vk_vip',
        capMicroUsd: 50,
        windows: [{ capMicroUsd: 50, period: { kind: 'daily' } }],
      },
      {
        workspaceId: WS,
        name: 'alice',
        scopeKind: 'user',
        scopeId: 'alice',
        capMicroUsd: 5,
        windows: [
          { capMicroUsd: 5, period: { kind: 'weekly' } },
          { capMicroUsd: 15, period: { kind: 'monthly' } },
        ],
      },
    ]);
    const resolve = createBudgetCapResolver(db);
    expect(await resolve(WS)).toEqual({ capMicroUsd: 100, periodSeconds: 3600 }); // legacy row → legacy shape
    expect(await resolve(`org:${ORG}`)).toEqual({
      windows: [{ capMicroUsd: 1_000, period: { kind: 'monthly' } }],
    });
    expect(await resolve(`key:${WS}:vk_vip`)).toEqual({
      windows: [{ capMicroUsd: 50, period: { kind: 'daily' } }],
    });
    expect(await resolve(`key:${WS}:vk_other`)).toEqual({
      windows: [{ capMicroUsd: 10, period: { kind: 'daily' } }],
    }); // the default
    expect(await resolve(`key:${WS2}:vk_other`)).toBeNull(); // defaults are per workspace
    expect(await resolve(`user:${WS}:alice`)).toEqual({
      windows: [
        { capMicroUsd: 5, period: { kind: 'weekly' } },
        { capMicroUsd: 15, period: { kind: 'monthly' } },
      ],
    });
    expect(await resolve(`user:${WS}:bob`)).toBeNull();
    expect(await resolve(`team:${WS}:ml`)).toBeNull();
    expect(await resolve('model:claude-x')).toBeNull(); // config-resolved
    expect(await resolve('attr:session:1')).toBeNull();
    expect(await resolve(`org:${WS}`)).toBeNull(); // a workspace id is not an org
  });

  it('heal data covers the active window of each scope the ledger can attribute', async () => {
    const now = Date.UTC(2026, 9, 11, 12, 0, 0);
    const row = (over: Partial<typeof schema.spendLedger.$inferInsert>) => ({
      requestId: `req_${Math.random().toString(36).slice(2)}`,
      principalId: 'vk_vip',
      orgId: ORG,
      workspaceId: WS,
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      status: 'ok',
      inputTokens: 1,
      outputTokens: 1,
      costMicroUsd: 100,
      priced: true,
      createdAt: new Date(now - 60_000),
      ...over,
    });
    await db.insert(schema.spendLedger).values([
      row({}), // this hour, vip key, alice? no user attr
      row({ attributes: { user: 'alice' }, costMicroUsd: 7 }),
      row({ createdAt: new Date(now - 2 * 3600_000), costMicroUsd: 1_000 }), // outside the 1h fixed window, inside the month
      row({ createdAt: new Date(Date.UTC(2026, 8, 30)), costMicroUsd: 50_000 }), // last month
    ]);
    const data = await loadBudgetHealData(db, now);
    const by = (scope: string, kind: string) =>
      data.find((d) => d.scope === scope && d.period.kind === kind);
    expect(by(WS, 'fixed')?.ledgerMicroUsd).toBe(107); // last hour only
    expect(by(`org:${ORG}`, 'monthly')?.ledgerMicroUsd).toBe(1_107); // this month, all of WS
    expect(by(`key:${WS}:vk_vip`, 'daily')?.ledgerMicroUsd).toBe(1_107); // today (incl. the 2h-old row), by principal
    expect(by(`user:${WS}:alice`, 'weekly')?.ledgerMicroUsd).toBe(7);
    expect(by(`user:${WS}:alice`, 'monthly')?.ledgerMicroUsd).toBe(7);
    expect(data.some((d) => d.scope === `key:${WS}:*`)).toBe(false); // defaults never heal
  });
});

describe('org budgets (pglite)', () => {
  it('validates, upserts, reads and deletes the org row; the resolver sees it as org:<id>', async () => {
    expect(orgBudgetProblem({ scope: { kind: 'key' }, capMicroUsd: 1 })).toMatch(/org/);
    expect(orgBudgetProblem({ windows: [] })).toMatch(/at least one/);
    expect(orgBudgetProblem({ scope: { kind: 'org' }, capMicroUsd: 5 })).toBeUndefined();
    const ORG2 = '44444444-4444-4444-8444-444444444444';
    await db.insert(schema.org).values({ id: ORG2, name: 'Beta' });
    expect(await getOrgBudget(db, ORG2)).toBeNull();
    const created = await upsertOrgBudget(db, ORG2, 'org-cap', {
      windows: [{ capMicroUsd: 7, period: 'weekly' }],
    });
    expect(created.config).toEqual({
      scope: { kind: 'org' },
      windows: [{ capMicroUsd: 7, period: { kind: 'weekly' } }],
    });
    const replaced = await upsertOrgBudget(db, ORG2, 'org-cap-2', {
      capMicroUsd: 9,
      periodSeconds: 60,
    });
    expect(replaced.id).toBe(created.id); // one row per org
    expect(replaced.config).toEqual({ scope: { kind: 'org' }, capMicroUsd: 9, periodSeconds: 60 });
    expect(await createBudgetCapResolver(db)(`org:${ORG2}`)).toEqual({
      capMicroUsd: 9,
      periodSeconds: 60,
    });
    expect(await deleteOrgBudget(db, ORG2)).toBe(true);
    expect(await deleteOrgBudget(db, ORG2)).toBe(false);
    expect(await getOrgBudget(db, ORG2)).toBeNull();
  });
});
