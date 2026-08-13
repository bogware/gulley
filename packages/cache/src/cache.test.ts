import { describe, expect, it } from 'vitest';
import { CacheEngine } from './engine';
import { InMemoryExactCache } from './exact';
import { exactKey, semanticText } from './key';
import type { CacheableRequest, CachedResponse, EmbeddingProvider } from './types';
import { cosineSimilarity, InMemoryVectorIndex } from './vector';

function req(scope: string, body: unknown, extra?: Partial<CacheableRequest>): CacheableRequest {
  return {
    scope,
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    path: '/v1/messages',
    body: Buffer.from(JSON.stringify(body)),
    ...extra,
  };
}

function resp(text: string): CachedResponse {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(text),
    streamed: false,
    model: 'claude-haiku-4-5',
    inputTokens: 10,
    outputTokens: 5,
    createdAtMs: 0,
  };
}

// Deterministic stand-in for a real embedder: normalizes to letters only, so
// two phrasings that differ only in punctuation/case embed identically.
class FakeEmbed implements EmbeddingProvider {
  readonly name = 'fake';
  readonly dimensions = 26;
  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(26).fill(0);
    for (const ch of text.toLowerCase()) {
      const idx = ch.charCodeAt(0) - 97;
      if (idx >= 0 && idx < 26) v[idx] = (v[idx] ?? 0) + 1;
    }
    return v;
  }
}

describe('exactKey', () => {
  it('ignores volatile fields but partitions by scope', () => {
    const a = exactKey(req('ws1', { model: 'm', stream: true, messages: [] }));
    const b = exactKey(req('ws1', { model: 'm', stream: false, messages: [] }));
    expect(a).toBe(b); // stream toggled -> same key
    const other = exactKey(req('ws2', { model: 'm', stream: true, messages: [] }));
    expect(other).not.toBe(a); // different scope -> different key
  });
});

describe('semanticText', () => {
  it('gathers system + message text', () => {
    const body = Buffer.from(
      JSON.stringify({ system: 'be brief', messages: [{ role: 'user', content: 'hi there' }] }),
    );
    expect(semanticText(body)).toBe('be brief\nhi there');
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical and ~0 for orthogonal', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });
});

describe('CacheEngine exact tier', () => {
  it('misses then hits on the same request', async () => {
    const engine = new CacheEngine({ exact: new InMemoryExactCache(), ttlSeconds: 60 });
    const r = req('ws1', { messages: [{ role: 'user', content: 'ping' }] });

    const miss = await engine.lookup(r);
    expect(miss.status).toBe('miss');
    await engine.store(r, resp('pong'), miss);

    const hit = await engine.lookup(r);
    expect(hit.status).toBe('hit-exact');
    expect(hit.response?.body.toString()).toBe('pong');
  });

  it('respects TTL expiry', async () => {
    let now = 1000;
    const exact = new InMemoryExactCache(() => now);
    const engine = new CacheEngine({ exact, ttlSeconds: 1 });
    const r = req('ws1', { messages: [{ role: 'user', content: 'ping' }] });
    await engine.store(r, resp('pong'), await engine.lookup(r));
    now += 2000; // past the 1s TTL
    expect((await engine.lookup(r)).status).toBe('miss');
  });
});

describe('CacheEngine semantic tier', () => {
  const make = (threshold: number): CacheEngine =>
    new CacheEngine({
      exact: new InMemoryExactCache(),
      semantic: { embed: new FakeEmbed(), index: new InMemoryVectorIndex(), threshold },
      ttlSeconds: 60,
    });

  it('serves a paraphrase from the semantic tier (distinct exact key)', async () => {
    const engine = make(0.9);
    const a = req('ws1', { messages: [{ role: 'user', content: 'Capital of France' }] });
    const miss = await engine.lookup(a);
    expect(miss.status).toBe('miss');
    expect(miss.embedding).toBeDefined();
    await engine.store(a, resp('Paris'), miss);

    // Different bytes (punctuation) -> exact miss, but same normalized text.
    const b = req('ws1', { messages: [{ role: 'user', content: 'capital of france?' }] });
    expect(exactKey(b)).not.toBe(exactKey(a));
    const hit = await engine.lookup(b);
    expect(hit.status).toBe('hit-semantic');
    expect(hit.response?.body.toString()).toBe('Paris');
  });

  it('never serves a semantic hit across different models', async () => {
    const engine = make(0.9);
    const a = req(
      'ws1',
      { messages: [{ role: 'user', content: 'Capital of France' }] },
      { model: 'model-a' },
    );
    await engine.store(a, resp('Paris'), await engine.lookup(a));
    // Same (near-identical) prompt but a DIFFERENT model -> different partition.
    const b = req(
      'ws1',
      { messages: [{ role: 'user', content: 'capital of france?' }] },
      { model: 'model-b' },
    );
    expect((await engine.lookup(b)).status).toBe('miss');
  });

  it('misses a dissimilar request and never crosses scopes', async () => {
    const engine = make(0.9);
    const a = req('ws1', { messages: [{ role: 'user', content: 'Capital of France' }] });
    await engine.store(a, resp('Paris'), await engine.lookup(a));

    const dissimilar = req('ws1', { messages: [{ role: 'user', content: 'weather tomorrow' }] });
    expect((await engine.lookup(dissimilar)).status).toBe('miss');

    const otherScope = req('ws2', { messages: [{ role: 'user', content: 'Capital of France' }] });
    expect((await engine.lookup(otherScope)).status).toBe('miss');
  });
});
