import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { InMemoryAuditSink } from '@gulley/pipeline';
import {
  type Database,
  InMemorySessionBlockStore,
  PostgresSessionBlockStore,
  schema,
  type SessionCostStats,
  sessionCostStats,
  sessionKey,
} from '@gulley/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RunawayDetector,
  type RunawayDetectorOptions,
  type SessionRunawayAlertEvent,
} from './runaway-detector';

/**
 * The runaway rule end to end over a seeded ledger (real `sessionCostStats` SQL,
 * real Postgres block store): one obviously runaway session is blocked, a busy-but-
 * normal one is not, a flagged session is alerted without a block, re-alerts are
 * suppressed within the TTL, and a held lock skips the tick.
 */
let client: PGlite;
let db: Database;

async function applyMigrations(pg: PGlite): Promise<void> {
  const dir = fileURLToPath(new URL('../../../packages/storage/migrations', import.meta.url));
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
const NOW = new Date(Date.UTC(2026, 9, 11, 12, 0, 0));
const ago = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);
const USD = 1_000_000;

const OPTS: RunawayDetectorOptions = {
  windowMinutes: 60,
  baselineDays: 7,
  minCostUsd: 5,
  action: 'block',
  blockTtlMinutes: 240,
};

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await applyMigrations(client);
  const base = { provider: 'anthropic', model: 'claude-sonnet-4-6', status: 'ok', workspaceId: WS };
  const rows: Array<typeof schema.spendLedger.$inferInsert> = [];
  // Principal p1: 30 ordinary sessions over the last week, ~$1 each (a flat baseline).
  for (let i = 0; i < 30; i++) {
    rows.push({
      ...base,
      requestId: `p1-s${i}-a`,
      principalId: 'p1',
      costMicroUsd: 0.6 * USD,
      attributes: { session: `p1-s${i}`, agent: 'claude-code' },
      createdAt: ago(24 * 60 * (i % 6) + 120 + i),
    });
    rows.push({
      ...base,
      requestId: `p1-s${i}-b`,
      principalId: 'p1',
      costMicroUsd: 0.4 * USD,
      attributes: { session: `p1-s${i}`, agent: 'claude-code' },
      createdAt: ago(24 * 60 * (i % 6) + 100 + i),
    });
  }
  // p1's runaway: $60 in the last 20 minutes (a looping subagent), legs included.
  for (let i = 0; i < 20; i++) {
    rows.push({
      ...base,
      requestId: `boom-${i}`,
      principalId: 'p1',
      costMicroUsd: 2.9 * USD,
      attributes: {
        session: 'boom',
        agent: 'claude-code',
        cc_agent: 'loop',
        request_class: 'subagent',
      },
      createdAt: ago(20 - i),
    });
    rows.push({
      ...base,
      requestId: `boom-${i}#classify`,
      principalId: 'p1',
      model: 'embed',
      costMicroUsd: 0.1 * USD,
      attributes: null,
      createdAt: ago(20 - i),
    });
  }
  // Principal p2: a busy but ordinary active session ($1.50) with little history
  // (falls back to the scope-wide p95).
  rows.push({
    ...base,
    requestId: 'p2-live',
    principalId: 'p2',
    costMicroUsd: 1.5 * USD,
    attributes: { session: 'p2-live', agent: 'codex' },
    createdAt: ago(5),
  });
  // A stale $40 session (last active two hours ago) is outside the active window.
  rows.push({
    ...base,
    requestId: 'old-big',
    principalId: 'p2',
    costMicroUsd: 40 * USD,
    attributes: { session: 'old-big' },
    createdAt: ago(120),
  });
  await db.insert(schema.spendLedger).values(rows);
});

afterAll(async () => {
  await client.close();
});

describe('RunawayDetector over a seeded ledger', () => {
  it('blocks the obvious runaway, leaves the normal session alone, audits and alerts', async () => {
    const blocks = new PostgresSessionBlockStore(db, () => NOW);
    const audit = new InMemoryAuditSink();
    const alerts: SessionRunawayAlertEvent[] = [];
    const detector = new RunawayDetector(OPTS, {
      stats: (w) => sessionCostStats(db, { workspaceIds: [WS], ...w }),
      blocks,
      audit,
      alerts: { emit: (e) => alerts.push(e) },
      now: () => NOW,
    });

    const r = await detector.tick();
    expect(r.skipped).toBe(false);
    expect(r.evaluated).toBe(2); // boom + p2-live are active; old-big is not
    expect(r.runaway.map((f) => [f.session, f.action])).toEqual([['boom', 'blocked']]);
    const boom = r.runaway[0]!;
    expect(boom.costMicroUsd).toBe(60 * USD); // 20 × $2.90 + 20 × $0.10 classifier legs
    expect(boom.principalId).toBe('p1');
    expect(boom.baselineSource).toBe('principal'); // p1 has 31 sessions ≥ 20
    expect(boom.baselineMicroUsd).toBe(2 * USD); // 2 × p95 of p1's other sessions ($1)
    expect(boom.orgP99MicroUsd).toBe(40 * USD); // p99 of the others = the stale $40 session

    expect(await blocks.isBlocked(WS, 'boom')).toBe(true);
    expect(await blocks.isBlocked(WS, 'p2-live')).toBe(false);
    expect(await blocks.isBlocked(WS, 'old-big')).toBe(false);
    const [row] = await blocks.list({ workspaceIds: [WS] });
    expect(row).toMatchObject({
      session: 'boom',
      source: 'runaway',
      createdBy: 'runaway-detector',
    });
    expect(row!.reason).toMatch(/^runaway: \$60\.00 exceeds baseline \$2\.00/);
    expect(row!.expiresAt?.getTime()).toBe(NOW.getTime() + 240 * 60_000);

    expect(audit.rows.map((a) => a.action)).toEqual(['session.runaway']);
    expect(audit.rows[0]).toMatchObject({
      actor: 'runaway-detector',
      target: 'boom',
      payload: { workspaceId: WS, principalId: 'p1', action: 'blocked', blockTtlMinutes: 240 },
    });
    expect(alerts).toEqual([
      {
        kind: 'session.runaway',
        session: 'boom',
        workspaceId: WS,
        principalId: 'p1',
        costMicroUsd: 60 * USD,
        baselineMicroUsd: 2 * USD,
        orgP99MicroUsd: 40 * USD,
        action: 'blocked',
        at: NOW.toISOString(),
        severity: 'critical',
      },
    ]);

    // A second tick (same replica, inside the TTL) neither re-blocks nor re-alerts.
    const again = await detector.tick();
    expect(again.runaway).toEqual([]);
    expect(alerts).toHaveLength(1);
    expect(audit.rows).toHaveLength(1);
    // A fresh replica sees the existing block and stays quiet too.
    const replica = new RunawayDetector(OPTS, {
      stats: (w) => sessionCostStats(db, { workspaceIds: [WS], ...w }),
      blocks,
      audit,
      alerts: { emit: (e) => alerts.push(e) },
      now: () => NOW,
    });
    expect((await replica.tick()).runaway).toEqual([]);
    expect(alerts).toHaveLength(1);
  });

  it('in flag mode alerts with warning severity and writes no block', async () => {
    const blocks = new InMemorySessionBlockStore(() => NOW);
    const audit = new InMemoryAuditSink();
    const alerts: SessionRunawayAlertEvent[] = [];
    const detector = new RunawayDetector(
      { ...OPTS, action: 'flag' },
      {
        stats: (w) => sessionCostStats(db, { workspaceIds: [WS], ...w }),
        blocks,
        audit,
        alerts: { emit: (e) => alerts.push(e) },
        now: () => NOW,
      },
    );
    const r = await detector.tick();
    expect(r.runaway.map((f) => [f.session, f.action])).toEqual([['boom', 'flagged']]);
    expect(await blocks.isBlocked(WS, 'boom')).toBe(false);
    expect(alerts[0]).toMatchObject({ action: 'flagged', severity: 'warning' });
    expect(audit.rows[0]?.payload).toMatchObject({ action: 'flagged' });
  });

  it('skips the tick when another replica holds the lock', async () => {
    const detector = new RunawayDetector(OPTS, {
      stats: () => {
        throw new Error('must not be called');
      },
      blocks: new InMemorySessionBlockStore(),
      audit: new InMemoryAuditSink(),
      withLock: async () => undefined,
    });
    expect(await detector.tick()).toEqual({ skipped: true, evaluated: 0, runaway: [] });
  });

  it('never fires below the absolute cost floor', async () => {
    const detector = new RunawayDetector(
      { ...OPTS, minCostUsd: 100 },
      {
        stats: (w) => sessionCostStats(db, { workspaceIds: [WS], ...w }),
        blocks: new InMemorySessionBlockStore(),
        audit: new InMemoryAuditSink(),
        now: () => NOW,
      },
    );
    expect((await detector.tick()).runaway).toEqual([]);
  });
});

describe('RunawayDetector.evaluate (pure)', () => {
  const session = (over: Partial<SessionCostStats['sessions'][number]>) => ({
    workspaceId: WS,
    session: 's',
    orgId: null,
    principalId: 'p',
    costMicroUsd: 0,
    requests: 1,
    firstAt: NOW.toISOString(),
    lastAt: NOW.toISOString(),
    ...over,
  });
  const detector = new RunawayDetector(OPTS, {
    stats: () => Promise.reject(new Error('unused')),
    blocks: new InMemorySessionBlockStore(),
    audit: new InMemoryAuditSink(),
  });

  it('uses leave-one-out percentiles for the costliest session and the scope-wide p95 for a thin principal', () => {
    const stats: SessionCostStats = {
      sessions: [
        session({ session: 'top', costMicroUsd: 30 * USD }),
        session({ session: 'second', costMicroUsd: 9 * USD }),
      ],
      principals: {
        p: {
          principalId: 'p',
          sessions: 2, // < 20 → scope-wide p95 applies
          p95MicroUsd: 30 * USD,
          p95ExcludingTopMicroUsd: 9 * USD,
          topSessionKey: sessionKey(WS, 'top'),
        },
      },
      org: {
        sessions: 2,
        p95MicroUsd: 30 * USD,
        p99MicroUsd: 30 * USD,
        p95ExcludingTopMicroUsd: 9 * USD,
        p99ExcludingTopMicroUsd: 9 * USD,
        topSessionKey: sessionKey(WS, 'top'),
      },
    };
    const findings = detector.evaluate(stats, NOW);
    // top: 30 > max(5, 2×9=18) and 30 > 9 (others' p99) → runaway via the org baseline.
    // second: 9 > max(5, 2×30=60) is false → not a runaway.
    expect(findings.map((f) => f.session)).toEqual(['top']);
    expect(findings[0]).toMatchObject({
      baselineMicroUsd: 18 * USD,
      orgP99MicroUsd: 9 * USD,
      baselineSource: 'org',
    });
  });

  it('ignores sessions outside the active window', () => {
    const stats: SessionCostStats = {
      sessions: [
        session({ session: 'stale', costMicroUsd: 500 * USD, lastAt: ago(61).toISOString() }),
      ],
      principals: {},
      org: {
        sessions: 1,
        p95MicroUsd: 500 * USD,
        p99MicroUsd: 500 * USD,
        p95ExcludingTopMicroUsd: 0,
        p99ExcludingTopMicroUsd: 0,
        topSessionKey: sessionKey(WS, 'stale'),
      },
    };
    expect(detector.evaluate(stats, NOW)).toEqual([]);
  });
});
