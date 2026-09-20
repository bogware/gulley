import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CACHE_MULTIPLIERS } from '@gulley/cost';
import { describe, expect, it } from 'vitest';
import { loadCatalogEntries } from './file';
import { parseModelsDev } from './models-dev';

function tmpCatalog(rows: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'gulley-catalog-'));
  const p = join(dir, 'catalog.json');
  writeFileSync(p, JSON.stringify(rows), 'utf8');
  return p;
}

describe('loadCatalogEntries — validated operator catalog', () => {
  it('accepts well-formed rows', () => {
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
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it('rejects a string, null, NaN or negative rate and names the row', () => {
    for (const bad of [
      { provider: 'anthropic', model: 'm', input: '$3', output: 15 },
      { provider: 'anthropic', model: 'm', input: null, output: 15 },
      { provider: 'anthropic', model: 'm', input: -1, output: 15 },
      { provider: '', model: 'm', input: 1, output: 1 },
    ]) {
      expect(() =>
        loadCatalogEntries(tmpCatalog([{ provider: 'ok', model: 'ok', input: 1, output: 1 }, bad])),
      ).toThrow(/row 1/);
    }
    expect(() => loadCatalogEntries(tmpCatalog({ not: 'an array' }))).toThrow(/not a JSON array/);
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
