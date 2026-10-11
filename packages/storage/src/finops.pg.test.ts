import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db';
import {
  agentCostTree,
  csvField,
  decodeFocusCursor,
  encodeFocusCursor,
  FOCUS_COLUMNS,
  FOCUS_CSV_HEADER,
  focusCsvLine,
  focusJsonlLine,
  focusRows,
  openFocusPage,
  sessionCostStats,
  sessionKey,
  toFocusRow,
} from './finops';
import * as schema from './schema';
import { org, spendLedger, workspace } from './schema';

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

const ORG = '00000000-0000-0000-0000-00000000aaaa';
const WS = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0); // 2026-10-10T12:00:00Z
const at = (minutes: number): Date => new Date(T0 + minutes * 60_000);

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await applyMigrations(client);
  await db.insert(org).values({ id: ORG, name: 'Acme' });
  await db.insert(workspace).values([
    { id: WS, orgId: ORG, name: 'Default' },
    { id: OTHER, orgId: ORG, name: 'Other' },
  ]);
  const base = { provider: 'anthropic', model: 'claude-sonnet-4-6', status: 'ok', orgId: ORG };
  const s1 = { session: 's1', prompt: 'pr1', agent: 'claude-code' };
  await db.insert(spendLedger).values([
    // --- session s1 (principal p1): main thread, a subagent with a nested child, a
    // compaction turn, a classifier leg with NO attributes, and a hedge leg.
    {
      ...base,
      requestId: 'r1',
      principalId: 'p1',
      workspaceId: WS,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
      costMicroUsd: 5000,
      cacheSavedMicroUsd: 1000,
      attributes: { ...s1 },
      createdAt: at(0),
    },
    {
      ...base,
      requestId: 'r2',
      principalId: 'p1',
      workspaceId: WS,
      inputTokens: 40,
      outputTokens: 20,
      costMicroUsd: 3000,
      attributes: { ...s1, cc_agent: 'a1', cc_parent_agent: 'main', request_class: 'subagent' },
      createdAt: at(1),
    },
    {
      ...base,
      requestId: 'r3',
      principalId: 'p1',
      workspaceId: WS,
      inputTokens: 10,
      outputTokens: 5,
      costMicroUsd: 1000,
      attributes: { ...s1, cc_agent: 'a2', cc_parent_agent: 'a1', request_class: 'subagent' },
      createdAt: at(2),
    },
    {
      ...base,
      requestId: 'r4',
      principalId: 'p1',
      workspaceId: WS,
      inputTokens: 200,
      outputTokens: 10,
      costMicroUsd: 2000,
      attributes: { ...s1, request_class: 'compaction' },
      createdAt: at(3),
    },
    {
      ...base,
      requestId: 'r1#classify',
      principalId: 'p1',
      workspaceId: WS,
      model: 'embed',
      inputTokens: 5,
      outputTokens: 0,
      costMicroUsd: 10,
      attributes: null,
      createdAt: at(0),
    },
    {
      ...base,
      requestId: 'r2#hedge-timeout',
      principalId: 'p1',
      workspaceId: WS,
      inputTokens: 40,
      outputTokens: 0,
      costMicroUsd: 500,
      attributes: { ...s1, cc_agent: 'a1', cc_parent_agent: 'main', request_class: 'subagent' },
      createdAt: at(1),
    },
    // --- session s2 (principal p2): a cheap session whose id would be a formula.
    {
      ...base,
      requestId: 'r7',
      principalId: 'p2',
      workspaceId: WS,
      provider: 'openai',
      model: 'gpt-5',
      inputTokens: 10,
      outputTokens: 10,
      costMicroUsd: 100,
      attributes: { session: '=s2,"x"', prompt: 'pr2', agent: 'codex' },
      createdAt: at(10),
    },
    // --- out of scope (another workspace) and un-sessioned rows.
    {
      ...base,
      requestId: 'r8',
      principalId: 'p3',
      workspaceId: OTHER,
      costMicroUsd: 99_000,
      attributes: { session: 's3' },
      createdAt: at(11),
    },
    {
      ...base,
      requestId: 'r9',
      principalId: 'p1',
      workspaceId: WS,
      costMicroUsd: 777,
      attributes: { repo: 'acme/api' },
      createdAt: at(12),
    },
  ]);
});

afterAll(async () => {
  await client.close();
});

describe('agentCostTree', () => {
  it('rolls up session → prompt → subagent, folding legs into their parent request', async () => {
    const { tree, rows, truncated } = await agentCostTree(db, { workspaceIds: [WS] });
    expect(truncated).toBe(false);
    expect(tree.map((s) => s.session)).toEqual(['s1', '=s2,"x"']);
    const s1 = tree[0]!;
    expect(s1.workspaceId).toBe(WS);
    expect(s1.principalId).toBe('p1');
    expect(s1.costMicroUsd).toBe(5000 + 3000 + 1000 + 2000 + 10 + 500);
    expect(s1.requests).toBe(4); // r1..r4; the #classify and #hedge legs fold in
    expect(s1.legs).toBe(6);
    expect(s1.cacheSavedMicroUsd).toBe(1000);
    expect(s1.compactionMicroUsd).toBe(2000);
    expect(s1.subagentMicroUsd).toBe(3000 + 1000 + 500);
    expect(s1.firstAt).toBe(at(0).toISOString());
    expect(s1.lastAt).toBe(at(3).toISOString());

    expect(s1.prompts).toHaveLength(1);
    const pr1 = s1.prompts[0]!;
    expect(pr1.prompt).toBe('pr1');
    // Main-thread spend: r1 (+ its attribute-less classifier leg) and the compaction turn.
    expect(pr1.direct.costMicroUsd).toBe(5000 + 10 + 2000);
    expect(pr1.direct.requests).toBe(2);
    expect(pr1.direct.legs).toBe(3);
    // Subagent a1 (with its hedge leg) nests a2 under it; a1's parent 'main' is not an agent.
    expect(pr1.agents).toHaveLength(1);
    const a1 = pr1.agents[0]!;
    expect(a1.ccAgent).toBe('a1');
    expect(a1.ccParentAgent).toBe('main');
    expect(a1.costMicroUsd).toBe(3500);
    expect(a1.requests).toBe(1);
    expect(a1.children.map((c) => c.ccAgent)).toEqual(['a2']);
    expect(a1.children[0]!.costMicroUsd).toBe(1000);

    // The flat rows are the grouped leaves the tree was built from.
    expect(rows.filter((r) => r.session === 's1')).toHaveLength(3);
    expect(rows.find((r) => r.session === 's1' && r.ccAgent === 'a2')?.ccParentAgent).toBe('a1');
  });

  it('drills into one session and still attributes its attribute-less legs', async () => {
    const { tree } = await agentCostTree(db, { workspaceIds: [WS], session: 's1' });
    expect(tree).toHaveLength(1);
    expect(tree[0]!.costMicroUsd).toBe(11_510);
    expect(tree[0]!.legs).toBe(6);
  });

  it('honours the time window and never leaks an out-of-scope workspace', async () => {
    const windowed = await agentCostTree(db, { workspaceIds: [WS], from: at(5), to: at(20) });
    expect(windowed.tree.map((s) => s.session)).toEqual(['=s2,"x"']);
    const all = await agentCostTree(db, {});
    expect(all.tree.map((s) => s.session)).toEqual(['s3', 's1', '=s2,"x"']);
    expect(await agentCostTree(db, { workspaceIds: [] })).toEqual({
      tree: [],
      rows: [],
      truncated: false,
    });
  });
});

describe('sessionCostStats', () => {
  it('returns per-session cost with principal p95 and scope-wide p95/p99, leave-one-out', async () => {
    const stats = await sessionCostStats(db, { workspaceIds: [WS] });
    expect(stats.sessions.map((s) => [s.session, s.costMicroUsd])).toEqual([
      ['s1', 11_510],
      ['=s2,"x"', 100],
    ]);
    expect(stats.sessions[0]).toMatchObject({
      workspaceId: WS,
      orgId: ORG,
      principalId: 'p1',
      requests: 4,
      firstAt: at(0).toISOString(),
      lastAt: at(3).toISOString(),
    });
    // Two sessions: the inclusive percentiles ARE the max; leave-one-out drops it.
    expect(stats.org).toEqual({
      sessions: 2,
      p95MicroUsd: 11_510,
      p99MicroUsd: 11_510,
      p95ExcludingTopMicroUsd: 100,
      p99ExcludingTopMicroUsd: 100,
      topSessionKey: sessionKey(WS, 's1'),
    });
    expect(stats.principals['p1']).toEqual({
      principalId: 'p1',
      sessions: 1,
      p95MicroUsd: 11_510,
      p95ExcludingTopMicroUsd: 0, // no other session for p1
      topSessionKey: sessionKey(WS, 's1'),
    });
    expect(stats.principals['p2']?.p95MicroUsd).toBe(100);
    expect(stats.principals['p3']).toBeUndefined(); // other workspace, out of scope
  });

  it('returns nothing for an empty scope', async () => {
    const stats = await sessionCostStats(db, { workspaceIds: [] });
    expect(stats.sessions).toEqual([]);
    expect(stats.org.sessions).toBe(0);
  });
});

describe('FOCUS export', () => {
  it('maps a ledger row to every FOCUS 1.2 column, in order', async () => {
    const { rows } = await focusRows(db, { workspaceIds: [WS], limit: 100 });
    expect(rows).toHaveLength(8); // every WS ledger row, legs and un-sessioned rows included
    const r1 = rows.find((r) => r.ResourceId === 'r1')!;
    expect(Object.keys(r1)).toEqual([...FOCUS_COLUMNS]);
    expect(r1).toMatchObject({
      BilledCost: 0.005,
      EffectiveCost: 0.005,
      ListCost: 0.006, // cost + cache saved
      ContractedCost: 0.005,
      BillingCurrency: 'USD',
      BillingAccountId: ORG,
      BillingAccountName: 'Acme',
      SubAccountId: WS,
      SubAccountName: 'Default',
      ChargeCategory: 'Usage',
      ChargeClass: null,
      ChargeFrequency: 'Usage-Based',
      ChargeDescription: 'anthropic/claude-sonnet-4-6 request',
      ChargePeriodStart: at(0).toISOString(),
      ChargePeriodEnd: at(0).toISOString(),
      BillingPeriodStart: '2026-10-01T00:00:00.000Z',
      BillingPeriodEnd: '2026-11-01T00:00:00.000Z',
      ServiceName: 'Gulley LLM Gateway',
      ServiceCategory: 'AI and Machine Learning',
      ServiceSubcategory: 'Generative AI',
      ProviderName: 'anthropic',
      PublisherName: 'Anthropic',
      InvoiceIssuerName: 'Gulley',
      ResourceId: 'r1',
      ResourceName: null,
      ResourceType: 'llm-request',
      RegionId: null,
      RegionName: null,
      SkuId: 'claude-sonnet-4-6',
      SkuPriceId: null,
      PricingCategory: 'Standard',
      PricingQuantity: 150,
      PricingUnit: 'Tokens',
      ConsumedQuantity: 150,
      ConsumedUnit: 'Tokens',
      ListUnitPrice: null,
      Tags: { session: 's1', prompt: 'pr1', agent: 'claude-code' },
      x_gulley_input_tokens: 100,
      x_gulley_output_tokens: 50,
      x_gulley_cache_read_tokens: 20,
      x_gulley_cache_write_tokens: 5,
      x_gulley_principal_id: 'p1',
      x_gulley_status: 'ok',
      x_gulley_session: 's1',
      x_gulley_prompt: 'pr1',
      x_gulley_agent: 'claude-code',
      x_gulley_cc_agent: null,
      x_gulley_request_class: null,
    });
    const r7 = rows.find((r) => r.ResourceId === 'r7')!;
    expect(r7.PublisherName).toBe('OpenAI');
    expect(r7.x_gulley_agent).toBe('codex');
    const leg = rows.find((r) => r.ResourceId === 'r1#classify')!;
    expect(leg.Tags).toEqual({});
    expect(leg.x_gulley_session).toBeNull();
  });

  it('maps publishers for every built-in provider and passes an unknown one through', () => {
    const mk = (provider: string) =>
      toFocusRow({
        id: 'x',
        requestId: 'x',
        principalId: 'p',
        orgId: null,
        orgName: null,
        workspaceId: null,
        workspaceName: null,
        provider,
        model: 'm',
        status: 'ok',
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheSavedMicroUsd: 0,
        costMicroUsd: 1,
        attributes: null,
        createdAt: new Date(T0),
      });
    expect(mk('bedrock').PublisherName).toBe('Amazon Web Services');
    expect(mk('azure').PublisherName).toBe('Microsoft');
    expect(mk('ollama').PublisherName).toBe('ollama');
    expect(mk('bedrock').BillingAccountName).toBeNull();
    expect(mk('bedrock').BilledCost).toBe(0.000001);
  });

  it('writes RFC 4180 CSV with formula-injection escaping and ordered JSON Lines', async () => {
    const { rows } = await focusRows(db, { workspaceIds: [WS], limit: 100 });
    expect(FOCUS_CSV_HEADER).toBe(`${FOCUS_COLUMNS.join(',')}\r\n`);
    const r7 = rows.find((r) => r.ResourceId === 'r7')!;
    const line = focusCsvLine(r7);
    expect(line.endsWith('\r\n')).toBe(true);
    expect(line.split(',').length).toBeGreaterThanOrEqual(FOCUS_COLUMNS.length);
    // The session id begins with `=` and holds a comma + quotes: prefixed with `'`,
    // quoted, inner quotes doubled — both in the Tags JSON and the extension column.
    expect(line).toContain(`"'=s2,""x"""`);
    // The Tags JSON is one quoted field (jsonb does not preserve key order); the
    // session value inside it is JSON-escaped, not formula-prefixed (it starts with `{`).
    expect(line).toContain(`""session"":""=s2,\\""x\\""""`);
    expect(line).toMatch(
      /,"\{""[a-z]+"":""[^,]*"",""[a-z]+"":""[^,]*"",""[a-z]+"":""[^}]*\}",10,10,0,0,p2,ok,/,
    );
    expect(csvField(null)).toBe('');
    expect(csvField(0.005)).toBe('0.005');
    expect(csvField('plain')).toBe('plain');
    expect(csvField('-1 lead')).toBe(`'-1 lead`);
    expect(csvField('+x')).toBe(`'+x`);
    expect(csvField('@cmd')).toBe(`'@cmd`);
    expect(csvField('a\nb')).toBe(`"a\nb"`);

    const jsonl = focusJsonlLine(r7);
    expect(jsonl.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(jsonl) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([...FOCUS_COLUMNS]);
    expect(parsed['Tags']).toEqual({ session: '=s2,"x"', prompt: 'pr2', agent: 'codex' });
    expect(parsed['EffectiveCost']).toBe(0.0001);
  });

  it('pages by keyset without overlap and round-trips the cursor', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await focusRows(db, { workspaceIds: [WS], limit: 3, cursor });
      seen.push(...page.rows.map((r) => String(r.ResourceId)));
      if (!page.nextCursor) break;
      const c = decodeFocusCursor(page.nextCursor)!;
      expect(encodeFocusCursor(c)).toBe(page.nextCursor);
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
    // Oldest first: r1 and its classifier leg share a timestamp, then r2…
    expect(seen.slice(0, 2).sort()).toEqual(['r1', 'r1#classify']);
    expect(seen[seen.length - 1]).toBe('r9');
    expect(decodeFocusCursor('not-a-cursor')).toBeUndefined();
    expect(await focusRows(db, { workspaceIds: [] })).toEqual({ rows: [] });
  });

  it('streams a bounded page in batches with the continuation known up front', async () => {
    const first = await openFocusPage(db, { workspaceIds: [WS], pageSize: 4, batchSize: 3 });
    expect(first.nextCursor).toBeDefined();
    const batches: number[] = [];
    const ids: string[] = [];
    for await (const b of first.batches()) {
      batches.push(b.length);
      ids.push(...b.map((r) => String(r.ResourceId)));
    }
    expect(batches).toEqual([3, 1]);
    expect(ids).toHaveLength(4);

    const second = await openFocusPage(db, {
      workspaceIds: [WS],
      pageSize: 4,
      batchSize: 3,
      cursor: first.nextCursor,
    });
    expect(second.nextCursor).toBeUndefined(); // 8 rows: 4 + 4, no third page
    const rest: string[] = [];
    for await (const b of second.batches()) rest.push(...b.map((r) => String(r.ResourceId)));
    expect(rest).toHaveLength(4);
    expect(new Set([...ids, ...rest]).size).toBe(8);

    // An exactly-full page has no continuation; a shorter window page neither.
    const exact = await openFocusPage(db, { workspaceIds: [WS], pageSize: 8 });
    expect(exact.nextCursor).toBeUndefined();
    let n = 0;
    for await (const b of exact.batches()) n += b.length;
    expect(n).toBe(8);
    const partial = await openFocusPage(db, { workspaceIds: [WS], pageSize: 50, from: at(10) });
    expect(partial.nextCursor).toBeUndefined();
    let m = 0;
    for await (const b of partial.batches()) m += b.length;
    expect(m).toBe(2); // r7 + r9
  });
});
