import { describe, expect, it } from 'vitest';
import { RequestTracer, type TraceEvent } from './tracer';

const evt = (requestId: string): TraceEvent => ({
  requestId,
  principalId: 'vk_1',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  status: 'ok',
  statusCode: 200,
  streamed: true,
  latencyMs: 12,
  costMicroUsd: 100,
  ts: 0,
});

describe('RequestTracer', () => {
  it('keeps a bounded ring (oldest evicted)', () => {
    const t = new RequestTracer(3);
    for (const id of ['a', 'b', 'c', 'd']) t.record(evt(id));
    expect(t.recent().map((e) => e.requestId)).toEqual(['b', 'c', 'd']);
  });

  it('delivers live events to subscribers until unsubscribed', () => {
    const t = new RequestTracer();
    const seen: string[] = [];
    const unsub = t.subscribe((e) => seen.push(e.requestId));
    t.record(evt('a'));
    expect(t.subscriberCount).toBe(1);
    unsub();
    t.record(evt('b'));
    expect(seen).toEqual(['a']); // 'b' arrived after unsubscribe
    expect(t.subscriberCount).toBe(0);
  });

  it('a throwing subscriber never breaks record()', () => {
    const t = new RequestTracer();
    t.subscribe(() => {
      throw new Error('boom');
    });
    const seen: string[] = [];
    t.subscribe((e) => seen.push(e.requestId));
    expect(() => t.record(evt('a'))).not.toThrow();
    expect(seen).toEqual(['a']); // the healthy subscriber still got it
  });
});
