import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db';
import { purgeExpiredOAuthCodes, purgeRequestLogsOlderThan, retentionCutoff } from './retention';
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

const UUID = '11111111-1111-1111-1111-111111111111';

async function seedRequestLog(id: string, createdAt: Date): Promise<void> {
  await db.insert(schema.requestLog).values({
    requestId: id,
    principalId: 'p',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    route: '/v1/messages',
    statusCode: 200,
    status: 'ok',
    createdAt,
  });
}

async function requestLogCount(): Promise<number> {
  return (await db.select().from(schema.requestLog)).length;
}

describe('retention sweeps (real SQL via pglite)', () => {
  it('purges request_log rows older than the cutoff in bounded batches, keeping recent ones', async () => {
    await db.delete(schema.requestLog);
    const now = new Date('2026-06-01T00:00:00Z');
    const old = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000); // 40d ago
    const recent = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1d ago
    for (let i = 0; i < 7; i++) await seedRequestLog(`old_${i}`, old);
    for (let i = 0; i < 3; i++) await seedRequestLog(`new_${i}`, recent);
    expect(await requestLogCount()).toBe(10);

    // 30-day retention with a tiny batch size to exercise the batched loop.
    const removed = await purgeRequestLogsOlderThan(db, retentionCutoff(now, 30), { batchSize: 2 });
    expect(removed).toBe(7); // only the 7 old rows
    expect(await requestLogCount()).toBe(3); // the 3 recent rows survive

    // Idempotent: a second sweep removes nothing.
    expect(await purgeRequestLogsOlderThan(db, retentionCutoff(now, 30))).toBe(0);
  });

  it('respects the per-run cap and drains the rest on the next call', async () => {
    await db.delete(schema.requestLog);
    const now = new Date('2026-06-01T00:00:00Z');
    const old = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 6; i++) await seedRequestLog(`o_${i}`, old);

    const first = await purgeRequestLogsOlderThan(db, retentionCutoff(now, 30), {
      batchSize: 2,
      maxPerRun: 4,
    });
    expect(first).toBe(4); // capped at maxPerRun
    expect(await requestLogCount()).toBe(2);
    const second = await purgeRequestLogsOlderThan(db, retentionCutoff(now, 30), { batchSize: 2 });
    expect(second).toBe(2);
    expect(await requestLogCount()).toBe(0);
  });

  it('purges expired device_code / auth_code and leaves live ones', async () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const past = new Date(now.getTime() - 60_000);
    const future = new Date(now.getTime() + 60 * 60_000);

    await db.insert(schema.deviceCode).values([
      {
        deviceCode: 'dc_dead',
        userCode: 'AAAA',
        clientId: 'c',
        status: 'pending',
        expiresAt: past,
      },
      {
        deviceCode: 'dc_live',
        userCode: 'BBBB',
        clientId: 'c',
        status: 'pending',
        expiresAt: future,
      },
    ]);
    await db.insert(schema.authCode).values([
      {
        code: 'ac_dead',
        clientId: 'c',
        redirectUri: 'https://x/cb',
        codeChallenge: 'ch',
        principalId: 'p',
        displayName: 'd',
        orgId: UUID,
        workspaceId: UUID,
        expiresAt: past,
      },
      {
        code: 'ac_live',
        clientId: 'c',
        redirectUri: 'https://x/cb',
        codeChallenge: 'ch',
        principalId: 'p',
        displayName: 'd',
        orgId: UUID,
        workspaceId: UUID,
        expiresAt: future,
      },
    ]);

    const res = await purgeExpiredOAuthCodes(db, now);
    expect(res).toEqual({ deviceCodes: 1, authCodes: 1 });

    expect((await db.select().from(schema.deviceCode)).length).toBe(1); // dc_live survives
    expect((await db.select().from(schema.authCode)).length).toBe(1); // ac_live survives
  });

  it('retentionCutoff subtracts the day window from now', () => {
    const now = new Date('2026-06-30T12:00:00Z');
    expect(retentionCutoff(now, 7).toISOString()).toBe('2026-06-23T12:00:00.000Z');
  });
});
