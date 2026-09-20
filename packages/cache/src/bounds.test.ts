import { describe, expect, it } from 'vitest';
import { InMemoryExactCache } from './exact';
import { exactKey } from './key';
import { InMemoryVectorIndex } from './vector';

const req = (body: unknown) => ({
  scope: 'ws',
  provider: 'anthropic',
  model: 'claude',
  path: '/v1/messages',
  body: Buffer.from(JSON.stringify(body)),
});

const resp = () => ({
  statusCode: 200,
  headers: {},
  body: Buffer.from('{}'),
  streamed: false,
  model: 'claude',
  inputTokens: 1,
  outputTokens: 1,
  createdAtMs: 0,
});

describe('exactKey — volatile fields are stripped at the top level only', () => {
  it('ignores top-level stream/metadata but keeps nested ones (they are content)', () => {
    const base = { model: 'claude', messages: [{ role: 'user', content: 'hi' }] };
    expect(exactKey(req({ ...base, stream: true, metadata: { user_id: 'u1' } }))).toBe(
      exactKey(req({ ...base, stream: false })),
    );
    const toolA = {
      ...base,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', input: { metadata: { a: 1 } } }] },
      ],
    };
    const toolB = {
      ...base,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', input: { metadata: { a: 2 } } }] },
      ],
    };
    expect(exactKey(req(toolA))).not.toBe(exactKey(req(toolB)));
    const schemaA = {
      ...base,
      tools: [{ input_schema: { properties: { stream: { type: 'boolean' } } } }],
    };
    const schemaB = { ...base, tools: [{ input_schema: { properties: {} } }] };
    expect(exactKey(req(schemaA))).not.toBe(exactKey(req(schemaB)));
  });
});

describe('InMemoryExactCache — bounded', () => {
  it('evicts the oldest entry past maxEntries and purges expired entries on write', async () => {
    let t = 0;
    const cache = new InMemoryExactCache({ maxEntries: 3, now: () => t });
    await cache.set('a', resp(), 10);
    await cache.set('b', resp(), 10);
    await cache.set('c', resp(), 10);
    await cache.set('d', resp(), 10);
    expect(cache.size).toBe(3);
    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('d')).not.toBeNull();
    t = 11_000;
    expect(cache.sweep()).toBe(3);
    expect(cache.size).toBe(0);
  });
});

describe('InMemoryVectorIndex — TTL + per-scope bound', () => {
  it('drops expired vectors on query and caps vectors per scope', async () => {
    let t = 0;
    const idx = new InMemoryVectorIndex({ maxPerScope: 2, now: () => t });
    await idx.upsert('s', 'v1', [1, 0], 10);
    await idx.upsert('s', 'v2', [0, 1], 10);
    await idx.upsert('s', 'v3', [1, 1]); // no TTL; evicts v1 (oldest)
    expect(idx.size('s')).toBe(2);
    expect((await idx.query('s', [1, 0], 5)).map((m) => m.id).sort()).toEqual(['v2', 'v3']);
    t = 11_000;
    expect((await idx.query('s', [1, 0], 5)).map((m) => m.id)).toEqual(['v3']);
  });
});
