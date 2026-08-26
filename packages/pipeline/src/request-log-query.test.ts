import { describe, expect, it } from 'vitest';
import { BatchingRequestLog } from './batching';
import { InMemoryRequestLog } from './memory';
import type { RequestLogEntry, RequestLogSink } from './ports';

function entry(over: Partial<RequestLogEntry>): RequestLogEntry {
  return {
    requestId: 'req',
    principalId: 'vk_1',
    workspaceId: 'ws_1',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    route: '/v1/messages',
    statusCode: 200,
    status: 'ok',
    streamed: true,
    inputTokens: 100,
    outputTokens: 20,
    costMicroUsd: 500,
    latencyMs: 300,
    createdAt: new Date('2026-08-25T10:00:00Z'),
    ...over,
  };
}

async function seed(log: InMemoryRequestLog): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await log.write(
      entry({
        requestId: `req_${i}`,
        provider: i % 2 === 0 ? 'anthropic' : 'openai',
        statusCode: i === 4 ? 500 : 200,
        status: i === 4 ? 'error' : 'ok',
        createdAt: new Date(Date.UTC(2026, 7, 25, 10, i)), // 10:00..10:04
      }),
    );
  }
}

describe('InMemoryRequestLog query', () => {
  it('filters by provider and status', async () => {
    const log = new InMemoryRequestLog();
    await seed(log);
    expect((await log.search({ provider: 'openai' })).entries).toHaveLength(2);
    expect((await log.search({ status: 'error' })).entries).toHaveLength(1);
    expect((await log.search({ minStatusCode: 400 })).entries[0]?.statusCode).toBe(500);
  });

  it('paginates newest-first with a stable keyset cursor', async () => {
    const log = new InMemoryRequestLog();
    await seed(log);
    const p1 = await log.search({ limit: 2 });
    expect(p1.entries.map((e) => e.requestId)).toEqual(['req_4', 'req_3']);
    expect(p1.nextCursor).toBeTruthy();

    const p2 = await log.search({ limit: 2, cursor: p1.nextCursor });
    expect(p2.entries.map((e) => e.requestId)).toEqual(['req_2', 'req_1']);

    const p3 = await log.search({ limit: 2, cursor: p2.nextCursor });
    expect(p3.entries.map((e) => e.requestId)).toEqual(['req_0']);
    expect(p3.nextCursor).toBeUndefined();
  });

  it('gets the latest entry for a requestId', async () => {
    const log = new InMemoryRequestLog();
    await seed(log);
    expect((await log.get('req_2'))?.provider).toBe('anthropic');
    expect(await log.get('nope')).toBeNull();
  });

  it('rolls up usage by time bucket and group', async () => {
    const log = new InMemoryRequestLog();
    await seed(log); // 5 entries within the 10:00 hour
    const hourly = await log.usage({
      from: new Date(Date.UTC(2026, 7, 25, 0)),
      to: new Date(Date.UTC(2026, 7, 26, 0)),
      bucket: 'hour',
    });
    expect(hourly).toHaveLength(1);
    expect(hourly[0]?.requests).toBe(5);
    expect(hourly[0]?.costMicroUsd).toBe(2500);

    const byProvider = await log.usage({
      from: new Date(Date.UTC(2026, 7, 25, 0)),
      to: new Date(Date.UTC(2026, 7, 26, 0)),
      bucket: 'hour',
      groupBy: 'provider',
    });
    expect(byProvider).toHaveLength(2);
    expect(byProvider.find((b) => b.group === 'anthropic')?.requests).toBe(3);
    expect(byProvider.find((b) => b.group === 'openai')?.requests).toBe(2);
  });
});

describe('BatchingRequestLog', () => {
  it('flushes on maxBatch via writeBatch and on close', async () => {
    const batches: number[] = [];
    const sink: RequestLogSink = {
      write: async () => {},
      writeBatch: async (es) => {
        batches.push(es.length);
      },
    };
    const b = new BatchingRequestLog(sink, { maxBatch: 3, intervalMs: 100_000 });
    await b.write(entry({}));
    await b.write(entry({}));
    expect(b.backlog()).toBe(2);
    await b.write(entry({})); // hits maxBatch → flush
    await Promise.resolve();
    expect(batches).toEqual([3]);

    await b.write(entry({}));
    await b.close(); // flush remainder
    expect(batches).toEqual([3, 1]);
  });

  it('falls back to per-entry write when the sink has no writeBatch', async () => {
    let count = 0;
    const sink: RequestLogSink = {
      write: async () => {
        count += 1;
      },
    };
    const b = new BatchingRequestLog(sink, { maxBatch: 2, intervalMs: 100_000 });
    await b.write(entry({}));
    await b.write(entry({}));
    await b.close();
    expect(count).toBe(2);
  });

  it('reports dropped entries via onError and does not throw', async () => {
    let dropped = 0;
    const sink: RequestLogSink = {
      write: async () => {},
      writeBatch: async () => {
        throw new Error('db down');
      },
    };
    const b = new BatchingRequestLog(sink, {
      maxBatch: 1,
      intervalMs: 100_000,
      onError: (_e, n) => {
        dropped += n;
      },
    });
    await b.write(entry({}));
    await Promise.resolve();
    await b.close();
    expect(dropped).toBe(1);
    expect(b.backlog()).toBe(0);
  });
});
