import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPricingCatalog } from './context';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe('loadPricingCatalog', () => {
  it('uses the bundled snapshot by default and layers contracted overrides over it', () => {
    const c = loadPricingCatalog({}, silent);
    expect(c.size).toBeGreaterThan(100);
    expect(c.lookup('anthropic', 'claude-haiku-5-5')?.tier?.aboveInputTokens).toBe(100_000);
    const o = loadPricingCatalog(
      {
        PRICING_OVERRIDES: JSON.stringify([
          { provider: 'bedrock', model: 'anthropic.claude-sonnet-5-5', input: 1.8, output: 9 },
        ]),
      },
      silent,
    );
    expect(o.overrideCount).toBe(1);
    expect(o.lookup('bedrock', 'us.anthropic.claude-sonnet-5-5-v1:0')?.input).toBe(1.8);
    expect(o.lookup('anthropic', 'claude-sonnet-5-5')?.input).toBe(2); // untouched
  });

  it('loads an operator file (raw models.dev shape) and an overrides file; malformed input fails loudly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gulley-pricing-'));
    const catalogFile = join(dir, 'catalog.json');
    writeFileSync(
      catalogFile,
      JSON.stringify({
        anthropic: {
          id: 'anthropic',
          models: {
            'claude-x': { id: 'claude-x', cost: { input: 1, output: 2 }, limit: { context: 1000 } },
          },
        },
      }),
    );
    const overridesFile = join(dir, 'overrides.json');
    writeFileSync(
      overridesFile,
      JSON.stringify([{ provider: 'anthropic', model: 'claude-x', input: 0.5, output: 1 }]),
    );
    const c = loadPricingCatalog(
      { MODELS_CATALOG_FILE: catalogFile, PRICING_OVERRIDES_FILE: overridesFile },
      silent,
    );
    expect(c.size).toBe(1);
    expect(c.lookup('anthropic', 'claude-x')?.input).toBe(0.5);
    expect(() =>
      loadPricingCatalog({ MODELS_CATALOG_FILE: join(dir, 'missing.json') }, silent),
    ).toThrow(/MODELS_CATALOG_FILE/);
    expect(() =>
      loadPricingCatalog({ PRICING_OVERRIDES: '[{"provider":"anthropic"}]' }, silent),
    ).toThrow(/PRICING_OVERRIDES/);
  });
});
