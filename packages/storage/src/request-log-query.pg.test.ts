import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { RequestLogEntry } from '@gulley/pipeline';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresRequestLog, PostgresRequestLogQuery } from './adapters';
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
      stmt = stmt.replace(/vector\(\d+\)/gi, 'text');
      await pg.exec(stmt);
    }
  }
}

const WS_A = '11111111-1111-1111-1111-111111111111';
const WS_B = '22222222-2222-2222-2222-222222222222';

const row = (
  o: Partial<RequestLogEntry> & { requestId: string; createdAt: Date },
): RequestLogEntry => ({
  principalId: 'vk_1',
  workspaceId: WS_A,
  provider: 'anthropic',
  model: 'claude',
  route: 'default',
  statusCode: 200,
  status: 'ok',
  streamed: true,
  inputTokens: 0,
  outputTokens: 0,
  costMicroUsd: 0,
  latencyMs: 0,
  ...o,
});

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await applyMigrations(client);
  const sink = new PostgresRequestLog(db);
  await sink.writeBatch([
    row({
      requestId: 'r1',
      latencyMs: 100,
      inputTokens: 10,
      outputTokens: 20,
      costMicroUsd: 100,
      createdAt: new Date('2026-08-27T10:00:00Z'),
    }),
    row({
      requestId: 'r2',
      latencyMs: 300,
      inputTokens: 5,
      outputTokens: 7,
      costMicroUsd: 50,
      createdAt: new Date('2026-08-27T10:30:00Z'),
    }),
    row({
      requestId: 'r3',
      provider: 'openai',
      statusCode: 500,
      status: 'error',
      latencyMs: 900,
      inputTokens: 8,
      createdAt: new Date('2026-08-27T10:45:00Z'),
    }),
    row({
      requestId: 'r4',
      workspaceId: WS_B,
      latencyMs: 200,
      inputTokens: 3,
      outputTokens: 4,
      costMicroUsd: 30,
      createdAt: new Date('2026-08-27T11:00:00Z'),
    }),
    row({
      requestId: 'r5',
      statusCode: 429,
      status: 'error',
      latencyMs: 50,
      inputTokens: 1,
      createdAt: new Date('2026-08-27T11:15:00Z'),
    }),
  ]);
});

afterAll(async () => {
  await client.close();
});

describe('PostgresRequestLogQuery (real SQL via pglite)', () => {
  const q = (): PostgresRequestLogQuery => new PostgresRequestLogQuery(db);

  it('searches workspace-scoped, newest-first, with keyset pagination', async () => {
    const p1 = await q().search({ workspaceIds: [WS_A], limit: 2 });
    expect(p1.entries.map((e) => e.requestId)).toEqual(['r5', 'r3']); // newest first
    expect(p1.nextCursor).toBeDefined();
    const p2 = await q().search({ workspaceIds: [WS_A], limit: 2, cursor: p1.nextCursor });
    expect(p2.entries.map((e) => e.requestId)).toEqual(['r2', 'r1']);
    expect(p2.nextCursor).toBeUndefined(); // no more pages
  });

  it('filters by provider and errors-only', async () => {
    const openai = await q().search({ provider: 'openai' });
    expect(openai.entries.map((e) => e.requestId)).toEqual(['r3']);
    const errors = await q().search({ workspaceIds: [WS_A], minStatusCode: 400 });
    expect(errors.entries.map((e) => e.requestId).sort()).toEqual(['r3', 'r5']);
  });

  it('gets a single row by requestId', async () => {
    const r = await q().get('r3');
    expect(r?.provider).toBe('openai');
    expect(r?.statusCode).toBe(500);
    expect(await q().get('nope')).toBeNull();
  });

  it('rolls up usage by hour with error-rate and p95 latency', async () => {
    const buckets = await q().usage({
      workspaceIds: [WS_A],
      from: new Date('2026-08-27T00:00:00Z'),
      to: new Date('2026-08-28T00:00:00Z'),
      bucket: 'hour',
      groupBy: 'provider',
    });
    const at = (start: string, group: string) =>
      buckets.find((b) => b.bucketStart === start && b.group === group);

    const anth10 = at('2026-08-27T10:00:00.000Z', 'anthropic');
    expect(anth10).toMatchObject({
      requests: 2,
      inputTokens: 15,
      outputTokens: 27,
      costMicroUsd: 150,
    });
    expect(anth10?.errorRate).toBe(0);
    expect(anth10?.p95LatencyMs).toBe(300); // percentile_disc over [100,300]

    const oai10 = at('2026-08-27T10:00:00.000Z', 'openai');
    expect(oai10).toMatchObject({ requests: 1, errorRate: 1, p95LatencyMs: 900 });

    const anth11 = at('2026-08-27T11:00:00.000Z', 'anthropic');
    expect(anth11).toMatchObject({ requests: 1, errorRate: 1, p95LatencyMs: 50 }); // r5 (429), r4 is WS_B
  });
});
