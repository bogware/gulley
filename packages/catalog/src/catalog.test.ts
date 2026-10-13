import { computeCost, type NormalizedUsage } from '@gulley/cost';
import { describe, expect, it } from 'vitest';
import { type CatalogEntry, ModelCatalog } from './catalog';
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

/** The raw api.json shape as served today (a trimmed excerpt). */
const RAW = {
  _meta: { source: 'https://models.dev/api.json', snapshotAt: '2026-10-11', note: 'ignored' },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'claude-haiku-5-5': {
        id: 'claude-haiku-5-5',
        name: 'Claude Haiku 5.5',
        release_date: '2026-10-07',
        limit: { context: 1000000, output: 128000 },
        cost: {
          input: 0.1,
          output: 0.5,
          cache_read: 0.01,
          cache_write: 0.125,
          tiers: [
            {
              input: 0.5,
              output: 2.5,
              cache_read: 0.05,
              cache_write: 0.625,
              tier: { type: 'context', size: 100000 },
            },
          ],
        },
      },
      'claude-opus-5-5': {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        release_date: '2026-09-22',
        limit: { context: 1000000, output: 128000 },
        cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
      },
      'claude-unpriced': { id: 'claude-unpriced', name: 'No price', cost: null, limit: {} },
      'claude-no-cost-key': { id: 'claude-no-cost-key', name: 'No cost key' },
      'claude-nan': { id: 'claude-nan', cost: { input: 'x', output: 1 } },
    },
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    models: {
      'gpt-5.4': {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        limit: { context: 1050000, input: 922000, output: 128000 },
        cost: {
          input: 2.5,
          output: 15,
          cache_read: 0.25,
          tiers: [
            { input: 9, output: 9, tier: { type: 'batch', size: 1 } }, // not a context tier
            { input: 5, output: 22.5, cache_read: 0.5, tier: { type: 'context', size: 272000 } },
          ],
          context_over_200k: { input: 5, output: 22.5, cache_read: 0.5 },
        },
      },
      'free-model': { id: 'free-model', name: 'Free', cost: { input: 0, output: 0 } },
    },
  },
  'amazon-bedrock': {
    id: 'amazon-bedrock',
    name: 'Amazon Bedrock',
    models: {
      'global.anthropic.claude-opus-5-5': {
        id: 'global.anthropic.claude-opus-5-5',
        name: 'Claude Opus 5.5',
        cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
        limit: { context: 1000000, output: 128000 },
      },
      'anthropic.claude-opus-5-5': {
        id: 'anthropic.claude-opus-5-5',
        name: 'Claude Opus 5.5',
        cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
        limit: { context: 1000000, output: 128000 },
      },
    },
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

  it('reads the raw api.json shape: tiers, cache, limits, name and release date', () => {
    const entries = parseModelsDev(RAW);
    const haiku = entries.find((e) => e.provider === 'anthropic' && e.model === 'claude-haiku-5-5');
    expect(haiku).toMatchObject({
      input: 0.1,
      output: 0.5,
      tier: { aboveInputTokens: 100_000, input: 0.5, output: 2.5 },
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
      displayName: 'Claude Haiku 5.5',
      releaseDate: '2026-10-07',
    });
    expect(haiku?.cache?.read).toBeCloseTo(0.1); // 0.01 / 0.1
    expect(haiku?.cache?.write5m).toBeCloseTo(1.25); // 0.125 / 0.1
    expect(haiku?.cache?.write1h).toBeCloseTo(2.0); // 1.25 × (2.0 / 1.25)

    const opus = entries.find((e) => e.provider === 'anthropic' && e.model === 'claude-opus-5-5');
    expect(opus?.cache?.read).toBeCloseTo(0.05); // 0.2 / 4
    expect(opus?.tier).toBeUndefined();

    // Only a `context`-type tier is a long-context tier; the first such entry wins.
    const gpt = entries.find((e) => e.provider === 'openai' && e.model === 'gpt-5.4');
    expect(gpt?.tier).toEqual({ aboveInputTokens: 272_000, input: 5, output: 22.5 });
    expect(gpt?.contextLength).toBe(1_050_000);
    expect(gpt?.maxOutputTokens).toBe(128_000);
    expect(gpt?.releaseDate).toBeUndefined();
  });

  it('keeps a $0/$0 model as priced (free), skips null/missing/non-finite cost', () => {
    const entries = parseModelsDev(RAW);
    const free = entries.find((e) => e.model === 'free-model');
    expect(free).toMatchObject({ provider: 'openai', input: 0, output: 0 });
    expect(free?.cache).toBeUndefined(); // no multipliers on a $0 base
    for (const skipped of ['claude-unpriced', 'claude-no-cost-key', 'claude-nan']) {
      expect(entries.find((e) => e.model === skipped)).toBeUndefined();
    }
  });

  it('ignores `_`-prefixed top-level keys (the snapshot `_meta`) and non-objects', () => {
    const entries = parseModelsDev(RAW);
    expect(entries.some((e) => e.provider === '_meta')).toBe(false);
    expect(parseModelsDev({ _meta: { models: { x: { cost: { input: 1, output: 1 } } } } })).toEqual(
      [],
    );
    expect(parseModelsDev(null)).toEqual([]);
    expect(parseModelsDev([])).toEqual([]);
    expect(parseModelsDev('nope')).toEqual([]);
  });

  it('aliases amazon-bedrock → bedrock and keeps the raw (prefixed) model id', () => {
    const entries = parseModelsDev(RAW).filter((e) => e.provider === 'bedrock');
    expect(entries.map((e) => e.model).sort()).toEqual([
      'anthropic.claude-opus-5-5',
      'global.anthropic.claude-opus-5-5',
    ]);
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

  it('carries the tier into the rate so computeCost bills the long-context tier', () => {
    const cat = new ModelCatalog(parseModelsDev(RAW));
    expect(cat.lookup('anthropic', 'claude-haiku-5-5')?.tier).toEqual({
      aboveInputTokens: 100_000,
      input: 0.5,
      output: 2.5,
    });
    const long = computeCost(
      'anthropic',
      'claude-haiku-5-5-20261007',
      usage({ inputTokens: 150_000, outputTokens: 1_000 }),
      cat.resolver(),
    );
    expect(long.inputUsd).toBeCloseTo(0.075, 9); // 150K × $0.50/MTok
    expect(long.outputUsd).toBeCloseTo(0.0025, 9); // 1K × $2.50/MTok
    const short = computeCost(
      'anthropic',
      'claude-haiku-5-5',
      usage({ inputTokens: 50_000 }),
      cat.resolver(),
    );
    expect(short.inputUsd).toBeCloseTo(0.005, 9);
    // Bedrock's regional ids collapse onto the alias; the shortest id is listed.
    expect(cat.lookup('bedrock', 'us.anthropic.claude-opus-5-5-v1:0')?.input).toBe(4);
    expect(cat.entry('bedrock', 'claude-opus-5-5')?.model).toBe('anthropic.claude-opus-5-5');
    expect(cat.entriesFor('bedrock')).toHaveLength(1);
  });

  it('overrides take precedence over the catalog and survive replace()', () => {
    const cat = new ModelCatalog(parseModelsDev(RAW));
    const negotiated: CatalogEntry = {
      provider: 'bedrock',
      model: 'claude-opus-5-5',
      input: 3.2,
      output: 16,
      cache: { read: 0.05, write5m: 1.25, write1h: 2 },
    };
    const extra: CatalogEntry = {
      provider: 'groq',
      model: 'llama-3.3-70b',
      input: 0.59,
      output: 0.79,
    };
    expect(cat.setOverrides([negotiated, extra])).toBe(2);
    expect(cat.overrideCount).toBe(2);
    expect(cat.size).toBe(5); // overrides are not catalog entries
    // Precedence: the override wins for the Bedrock alias (any regional spelling)...
    expect(cat.lookup('bedrock', 'global.anthropic.claude-opus-5-5')?.input).toBe(3.2);
    expect(cat.entry('bedrock', 'claude-opus-5-5')).toBe(negotiated);
    // ...the first-party price is untouched, and an override-only model resolves.
    expect(cat.lookup('anthropic', 'claude-opus-5-5')?.input).toBe(4);
    expect(cat.lookup('groq', 'llama-3.3-70b')?.output).toBe(0.79);
    expect(cat.all().filter((e) => e.provider === 'bedrock')).toEqual([negotiated]);

    // A catalog reload keeps the overrides...
    cat.replace([{ provider: 'anthropic', model: 'claude-opus-5-5', input: 5, output: 25 }]);
    expect(cat.size).toBe(1);
    expect(cat.lookup('bedrock', 'claude-opus-5-5')?.input).toBe(3.2);
    expect(cat.lookup('groq', 'llama-3.3-70b')?.input).toBe(0.59);
    expect(cat.lookup('anthropic', 'claude-opus-5-5')?.input).toBe(5);
    // ...and clearing them falls back to the catalog.
    expect(cat.setOverrides([])).toBe(0);
    expect(cat.lookup('bedrock', 'claude-opus-5-5')).toBeUndefined();
    expect(cat.lookup('groq', 'llama-3.3-70b')).toBeUndefined();
  });

  it('entriesFor() lists one provider, overrides layered in, sorted by model id', () => {
    const cat = new ModelCatalog([
      { provider: 'openai', model: 'gpt-5.4', input: 2.5, output: 15 },
      { provider: 'openai', model: 'gpt-4o', input: 2.5, output: 10 },
      { provider: 'openai', model: 'o3', input: 2, output: 8 },
      { provider: 'anthropic', model: 'claude-opus-5-5', input: 4, output: 20 },
    ]);
    cat.setOverrides([
      { provider: 'openai', model: 'gpt-4o', input: 2, output: 8 }, // replaces by key
      { provider: 'openai', model: 'gpt-5.5', input: 5, output: 30 }, // new
    ]);
    const listed = cat.entriesFor('openai');
    expect(listed.map((e) => e.model)).toEqual(['gpt-4o', 'gpt-5.4', 'gpt-5.5', 'o3']);
    expect(listed.find((e) => e.model === 'gpt-4o')?.output).toBe(8);
    expect(cat.entriesFor('anthropic').map((e) => e.model)).toEqual(['claude-opus-5-5']);
    expect(cat.entriesFor('nope')).toEqual([]);
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
