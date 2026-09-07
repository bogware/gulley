import { describe, expect, it } from 'vitest';
import {
  parseAnthropicCostReport,
  parseOpenAICostReport,
  reconcileShadowSpend,
  runShadowSpendReconciliation,
  type ProviderUsageSource,
} from './shadow-spend';

describe('reconcileShadowSpend', () => {
  it('flags a provider whose billed spend exceeds the gateway ledger beyond the threshold', () => {
    const report = reconcileShadowSpend(
      [{ provider: 'anthropic', costMicroUsd: 1_000_000 }],
      [{ provider: 'anthropic', costMicroUsd: 600_000 }],
      { flagRatioBps: 500 }, // 5%
    );
    const row = report.rows.find((r) => r.provider === 'anthropic')!;
    expect(row.shadowMicroUsd).toBe(400_000); // 40% bypassed the gateway
    expect(row.shadowRatio).toBeCloseTo(0.4, 5);
    expect(row.flagged).toBe(true);
    expect(report.flagged).toBe(true);
    expect(report.shadowTotalMicroUsd).toBe(400_000);
    expect(report.reconciledProviders).toEqual(['anthropic']);
  });

  it('does not flag when the gateway mediated (at least) all provider-billed spend', () => {
    const report = reconcileShadowSpend(
      [{ provider: 'openai', costMicroUsd: 500_000 }],
      [{ provider: 'openai', costMicroUsd: 500_000 }],
    );
    const row = report.rows[0]!;
    expect(row.shadowMicroUsd).toBe(0);
    expect(row.flagged).toBe(false);
    expect(report.flagged).toBe(false);
  });

  it('sums models per provider (robust to model-name mismatch)', () => {
    const report = reconcileShadowSpend(
      [
        { provider: 'anthropic', costMicroUsd: 300_000 },
        { provider: 'anthropic', costMicroUsd: 700_000 },
      ],
      [{ provider: 'anthropic', costMicroUsd: 200_000 }],
    );
    const row = report.rows[0]!;
    expect(row.providerMicroUsd).toBe(1_000_000);
    expect(row.shadowMicroUsd).toBe(800_000);
  });

  it('never flags a gateway-only provider (no provider-side data = no evidence of bypass)', () => {
    const report = reconcileShadowSpend(
      [], // no provider usage reconciled
      [{ provider: 'bedrock', costMicroUsd: 900_000 }],
    );
    const row = report.rows.find((r) => r.provider === 'bedrock')!;
    expect(row.providerMicroUsd).toBe(0);
    expect(row.shadowMicroUsd).toBe(0);
    expect(row.flagged).toBe(false);
    expect(report.reconciledProviders).toEqual([]);
    expect(report.flagged).toBe(false);
  });

  it('honors a custom flag ratio (basis points)', () => {
    // 10% shadow: flagged at 500bps (5%), NOT flagged at 2000bps (20%).
    const provider = [{ provider: 'anthropic', costMicroUsd: 1_000_000 }];
    const gateway = [{ provider: 'anthropic', costMicroUsd: 900_000 }];
    expect(reconcileShadowSpend(provider, gateway, { flagRatioBps: 500 }).flagged).toBe(true);
    expect(reconcileShadowSpend(provider, gateway, { flagRatioBps: 2000 }).flagged).toBe(false);
  });
});

describe('provider cost-report parsers', () => {
  it('parses the Anthropic cost report, summing USD line items into micro-USD', () => {
    const json = {
      data: [
        { results: [{ amount: '1.50', currency: 'USD' }] },
        {
          results: [
            { amount: '2.25', currency: 'USD' },
            { amount: '0.25', currency: 'USD' },
          ],
        },
      ],
    };
    expect(parseAnthropicCostReport(json)).toEqual([
      { provider: 'anthropic', costMicroUsd: 4_000_000 }, // (1.50 + 2.25 + 0.25) USD
    ]);
  });

  it('parses the OpenAI costs report (amount.value in USD)', () => {
    const json = {
      data: [
        { results: [{ amount: { value: 3.0, currency: 'usd' } }] },
        { results: [{ amount: { value: 1.5, currency: 'usd' } }] },
      ],
    };
    expect(parseOpenAICostReport(json)).toEqual([{ provider: 'openai', costMicroUsd: 4_500_000 }]);
  });

  it('returns [] for an empty / unrecognized report (no spend claimed)', () => {
    expect(parseAnthropicCostReport({ data: [] })).toEqual([]);
    expect(parseAnthropicCostReport({})).toEqual([]);
    expect(parseOpenAICostReport({ data: [{ results: [] }] })).toEqual([]);
  });
});

describe('runShadowSpendReconciliation', () => {
  const from = new Date('2026-09-01T00:00:00Z');
  const to = new Date('2026-09-07T00:00:00Z');

  it('pulls each source and reconciles against the gateway totals', async () => {
    const anthropic: ProviderUsageSource = () =>
      Promise.resolve([{ provider: 'anthropic', costMicroUsd: 1_000_000 }]);
    const report = await runShadowSpendReconciliation(
      [{ provider: 'anthropic', costMicroUsd: 700_000 }],
      [anthropic],
      from,
      to,
    );
    expect(report.rows[0]?.shadowMicroUsd).toBe(300_000);
    expect(report.flagged).toBe(true);
  });

  it('degrades gracefully when a provider source throws (reports the reachable ones)', async () => {
    const good: ProviderUsageSource = () =>
      Promise.resolve([{ provider: 'openai', costMicroUsd: 500_000 }]);
    const bad: ProviderUsageSource = () => Promise.reject(new Error('admin API down'));
    const report = await runShadowSpendReconciliation(
      [{ provider: 'openai', costMicroUsd: 100_000 }],
      [bad, good],
      from,
      to,
    );
    // The reachable provider is still reconciled; the failing one is simply absent.
    expect(report.reconciledProviders).toEqual(['openai']);
    expect(report.rows.find((r) => r.provider === 'openai')?.shadowMicroUsd).toBe(400_000);
  });
});
