import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CACHE_MULTIPLIERS } from '@gulley/cost';
import { describe, expect, it } from 'vitest';
import { ModelCatalog } from './catalog';
import {
  detectCatalogShape,
  loadCatalogEntries,
  loadCatalogFromFile,
  parsePricingOverrides,
  reloadCatalogFile,
  writeCatalogFile,
} from './file';
import { parseModelsDev } from './models-dev';

function tmpCatalog(rows: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'gulley-catalog-'));
  const p = join(dir, 'catalog.json');
  writeFileSync(p, JSON.stringify(rows), 'utf8');
  return p;
}

const RAW = {
  _meta: { source: 'https://models.dev/api.json', snapshotAt: '2026-10-11' },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'claude-opus-5-5': {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
        limit: { context: 1000000, output: 128000 },
      },
    },
  },
};

describe('loadCatalogEntries — validated operator catalog', () => {
  it('accepts well-formed rows, including the tier and listing metadata', () => {
    const rows = loadCatalogEntries(
      tmpCatalog([
        { provider: 'anthropic', model: 'claude-x', input: 3, output: 15 },
        {
          provider: 'openai',
          model: 'gpt-y',
          input: 0,
          output: 0,
          cache: { read: 0.5, write5m: 1, write1h: 1 },
          contextLength: 128000,
        },
        {
          provider: 'anthropic',
          model: 'claude-haiku-5-5',
          input: 0.1,
          output: 0.5,
          tier: { aboveInputTokens: 100000, input: 0.5, output: 2.5 },
          maxOutputTokens: 128000,
          displayName: 'Claude Haiku 5.5',
          releaseDate: '2026-10-07',
        },
      ]),
    );
    expect(rows).toHaveLength(3);
    expect(rows[2]?.tier).toEqual({ aboveInputTokens: 100000, input: 0.5, output: 2.5 });
  });

  it('rejects a string, null, NaN or negative rate and names the row', () => {
    for (const bad of [
      { provider: 'anthropic', model: 'm', input: '$3', output: 15 },
      { provider: 'anthropic', model: 'm', input: null, output: 15 },
      { provider: 'anthropic', model: 'm', input: -1, output: 15 },
      { provider: '', model: 'm', input: 1, output: 1 },
      {
        provider: 'a',
        model: 'm',
        input: 1,
        output: 1,
        tier: { aboveInputTokens: 0, input: 1, output: 1 },
      },
      {
        provider: 'a',
        model: 'm',
        input: 1,
        output: 1,
        tier: { aboveInputTokens: 10, input: '1', output: 1 },
      },
      { provider: 'a', model: 'm', input: 1, output: 1, maxOutputTokens: 1.5 },
    ]) {
      expect(() =>
        loadCatalogEntries(tmpCatalog([{ provider: 'ok', model: 'ok', input: 1, output: 1 }, bad])),
      ).toThrow(/row 1/);
    }
    expect(() => loadCatalogEntries(tmpCatalog({ not: 'an array' }))).toThrow(/not a JSON array/);
  });
});

describe('detectCatalogShape / loadCatalogFromFile — shape auto-detection', () => {
  it('tells a CatalogEntry[] from a raw models.dev payload', () => {
    expect(detectCatalogShape([])).toBe('entries');
    expect(detectCatalogShape([{ provider: 'a', model: 'm', input: 1, output: 1 }])).toBe(
      'entries',
    );
    expect(detectCatalogShape(RAW)).toBe('models-dev');
    expect(detectCatalogShape({ anthropic: { models: {} } })).toBe('models-dev');
    // `_meta` alone is not a provider; neither is a provider without `models`.
    expect(detectCatalogShape({ _meta: { models: {} } })).toBe('unknown');
    expect(detectCatalogShape({ anthropic: { id: 'anthropic' } })).toBe('unknown');
    expect(detectCatalogShape({})).toBe('unknown');
    expect(detectCatalogShape(null)).toBe('unknown');
    expect(detectCatalogShape('x')).toBe('unknown');
  });

  it('loads a raw models.dev file through parseModelsDev', () => {
    const cat = loadCatalogFromFile(tmpCatalog(RAW));
    expect(cat.size).toBe(1);
    expect(cat.lookup('anthropic', 'claude-opus-5-5')?.cache?.read).toBeCloseTo(0.05);
    expect(cat.entry('anthropic', 'claude-opus-5-5')?.maxOutputTokens).toBe(128000);
  });

  it('still loads the CatalogEntry[] shape writeCatalogFile emits', () => {
    const p = tmpCatalog([]);
    writeCatalogFile(p, parseModelsDev(RAW));
    const cat = loadCatalogFromFile(p);
    expect(cat.lookup('anthropic', 'claude-opus-5-5')?.input).toBe(4);
  });

  it('rejects a models.dev payload with no priced model and an unknown shape', () => {
    expect(() =>
      loadCatalogFromFile(tmpCatalog({ anthropic: { models: { x: { cost: null } } } })),
    ).toThrow(/no priced models/);
    expect(() => loadCatalogFromFile(tmpCatalog({ _meta: {} }))).toThrow(/not a JSON array/);
  });
});

describe('reloadCatalogFile', () => {
  it('replaces into an existing instance, keeping overrides, and leaves it untouched on failure', () => {
    const cat = new ModelCatalog([{ provider: 'anthropic', model: 'old', input: 1, output: 1 }]);
    cat.setOverrides([{ provider: 'bedrock', model: 'claude-opus-5-5', input: 3, output: 15 }]);
    expect(reloadCatalogFile(tmpCatalog(RAW), cat)).toBe(1);
    expect(cat.lookup('anthropic', 'old')).toBeUndefined();
    expect(cat.lookup('anthropic', 'claude-opus-5-5')?.input).toBe(4);
    expect(cat.lookup('bedrock', 'claude-opus-5-5')?.input).toBe(3);

    const bad = tmpCatalog([{ provider: 'anthropic', model: 'm', input: 'x', output: 1 }]);
    expect(() => reloadCatalogFile(bad, cat)).toThrow(/row 0/);
    expect(cat.lookup('anthropic', 'claude-opus-5-5')?.input).toBe(4);
    expect(cat.lookup('bedrock', 'claude-opus-5-5')?.input).toBe(3);
  });
});

describe('parsePricingOverrides', () => {
  it('validates with the catalog-entry schema and names the bad row', () => {
    const rows = parsePricingOverrides([
      { provider: 'bedrock', model: 'claude-opus-5-5', input: 3.2, output: 16 },
      {
        provider: 'azure',
        model: 'gpt-5.4',
        input: 2,
        output: 12,
        tier: { aboveInputTokens: 272000, input: 4, output: 18 },
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.tier?.aboveInputTokens).toBe(272000);
    expect(() => parsePricingOverrides({ provider: 'x' })).toThrow(/not a JSON array/);
    expect(() =>
      parsePricingOverrides([{ provider: 'x', model: 'm', input: 1, output: Number.NaN }]),
    ).toThrow(/pricing overrides row 0: output/);
    expect(() => parsePricingOverrides([{ provider: 'x', model: 'm', input: 1 }])).toThrow(
      /row 0: output/,
    );
  });
});

describe('parseModelsDev — cache write tiers', () => {
  it('derives the 1h write multiplier from the 5m price at the provider ratio', () => {
    const entries = parseModelsDev({
      anthropic: {
        models: {
          'claude-z': { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
        },
      },
    });
    const e = entries.find((x) => x.model === 'claude-z');
    expect(e?.cache?.write5m).toBeCloseTo(1.25, 5);
    expect(e?.cache?.write1h).toBeCloseTo(
      1.25 * (CACHE_MULTIPLIERS.write1h / CACHE_MULTIPLIERS.write5m),
      5,
    );
    expect(e?.cache?.write1h).toBeGreaterThan(e?.cache?.write5m ?? 0);
  });
});
