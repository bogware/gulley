import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

describe('pricing config defaults (0.6)', () => {
  it('fails closed on unpriced models by default, catalog reload off, no overrides', () => {
    const c = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv);
    expect(c.METER_FAIL_CLOSED_ON_UNPRICED).toBe(true);
    expect(c.PRICING_RELOAD_INTERVAL_SECONDS).toBe(0);
    expect(c.PRICING_OVERRIDES).toBeUndefined();
    expect(c.PRICING_OVERRIDES_FILE).toBeUndefined();
    expect(
      loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        METER_FAIL_CLOSED_ON_UNPRICED: 'false',
      } as NodeJS.ProcessEnv).METER_FAIL_CLOSED_ON_UNPRICED,
    ).toBe(false);
  });
});
