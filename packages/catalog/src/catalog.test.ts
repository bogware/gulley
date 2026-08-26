import { computeCost, type NormalizedUsage } from '@gulley/cost';
import { describe, expect, it } from 'vitest';
import { ModelCatalog } from './catalog';
import { fetchModelsDev, parseModelsDev } from './models-dev';

const MODELS_DEV = {
  anthropic: {
    models: {
      'claude-sonnet-4-6': {
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        limit: { context: 200000 },
      },
    },
  },
  google: {
    models: {
      'gemini-2.5-pro': { cost: { input: 1.25, output: 10 }, limit: { context: 1000000 } },
      'gemini-free': { cost: {} }, // unpriced → skipped
    },
  },
  groq: {
    models: { 'llama-3.3-70b': { cost: { input: 0.59, output: 0.79 } } },
  },
};

const usage = (over: Partial<NormalizedUsage> = {}): NormalizedUsage => ({
  inputTokens: 1_000_000,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  outputTokens: 0,
  seen: true,
  ...over,
});

describe('parseModelsDev', () => {
  it('maps priced models, aliases providers, converts cache to multipliers, skips unpriced', () => {
    const entries = parseModelsDev(MODELS_DEV);
    const gemini = entries.find((e) => e.model === 'gemini-2.5-pro');
    expect(gemini?.provider).toBe('gemini'); // google → gemini
    expect(gemini?.contextLength).toBe(1_000_000);
    expect(entries.find((e) => e.model === 'gemini-free')).toBeUndefined(); // unpriced skipped

    const claude = entries.find((e) => e.model === 'claude-sonnet-4-6');
    expect(claude?.cache?.read).toBeCloseTo(0.1); // 0.3 / 3
    expect(claude?.cache?.write5m).toBeCloseTo(1.25); // 3.75 / 3
    expect(entries.find((e) => e.provider === 'groq')).toBeTruthy();
  });
});

describe('ModelCatalog', () => {
  it('looks up by normalized model id and drives computeCost', () => {
    const cat = new ModelCatalog(parseModelsDev(MODELS_DEV));
    expect(cat.size).toBe(3);
    // A groq model the seed table doesn't know is now priced via the catalog.
    const cost = computeCost('groq', 'llama-3.3-70b', usage(), cat.resolver());
    expect(cost.priced).toBe(true);
    expect(cost.inputUsd).toBeCloseTo(0.59); // 1M input @ 0.59/1M
    // Dated response id still resolves to its alias.
    expect(cat.lookup('gemini', 'gemini-2.5-pro-2026-01-01')?.input).toBe(1.25);
  });

  it('replace() atomically swaps and keeps count', () => {
    const cat = new ModelCatalog(parseModelsDev(MODELS_DEV));
    const n = cat.replace([{ provider: 'x', model: 'y', input: 1, output: 2 }]);
    expect(n).toBe(1);
    expect(cat.lookup('groq', 'llama-3.3-70b')).toBeUndefined(); // old contents gone
    expect(cat.lookup('x', 'y')?.output).toBe(2);
  });
});

describe('fetchModelsDev', () => {
  const okFetch = (payload: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;

  it('fetches and parses', async () => {
    const entries = await fetchModelsDev({ fetchImpl: okFetch(MODELS_DEV) });
    expect(entries.length).toBe(3);
  });

  it('throws on a non-200 (caller keeps last-valid)', async () => {
    const bad = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await expect(fetchModelsDev({ fetchImpl: bad })).rejects.toThrow(/500/);
  });

  it('throws when the payload has no priced models', async () => {
    await expect(fetchModelsDev({ fetchImpl: okFetch({}) })).rejects.toThrow(/no priced/);
  });
});
