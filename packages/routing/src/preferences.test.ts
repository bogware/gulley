import { describe, expect, it } from 'vitest';
import { applyRoutingPreferences, extractRoutingPreferences } from './preferences';
import type { RouteTarget } from './types';

const t = (name: string, provider = name, extra: Partial<RouteTarget> = {}): RouteTarget => ({
  name,
  provider,
  adapter: { name, forward: async () => ({ statusCode: 200, headers: {}, body: null as never }) },
  credential: { scheme: 'bearer', value: 'k' },
  upstreamPath: '/v1/messages',
  ...extra,
});

describe('extractRoutingPreferences', () => {
  it('reads the OpenRouter `provider` object and strips it from the body', () => {
    const body: Record<string, unknown> = {
      model: 'claude-sonnet-5-5',
      provider: {
        order: ['Bedrock', 'anthropic'],
        only: ['bedrock', 'anthropic'],
        ignore: ['azure'],
        allow_fallbacks: false,
        sort: { by: 'throughput', partition: 'none' },
        zdr: true,
        max_price: { prompt: 3, completion: 15, request: 0 },
        require_parameters: true, // ignored
        quantizations: ['fp8'], // ignored
      },
    };
    const { prefs, stripped } = extractRoutingPreferences(body);
    expect(stripped).toBe(true);
    expect(body['provider']).toBeUndefined();
    expect(prefs).toEqual({
      order: ['bedrock', 'anthropic'],
      only: ['bedrock', 'anthropic'],
      ignore: ['azure'],
      allowFallbacks: false,
      sort: 'throughput',
      zdr: true,
      maxPrice: { prompt: 3, completion: 15 },
    });
  });

  it('reads Vercel `providerOptions.gateway` (cost/ttft/tps sorts) and strips the whole providerOptions', () => {
    const body: Record<string, unknown> = {
      model: 'anthropic/claude-sonnet-5',
      providerOptions: {
        gateway: { order: ['bedrock'], only: ['bedrock', 'anthropic'], sort: 'ttft' },
        other: 1,
      },
    };
    const { prefs, stripped } = extractRoutingPreferences(body);
    expect(stripped).toBe(true);
    expect(body['providerOptions']).toBeUndefined();
    expect(prefs).toEqual({ order: ['bedrock'], only: ['bedrock', 'anthropic'], sort: 'latency' });
    expect(
      extractRoutingPreferences({ providerOptions: { gateway: { sort: 'cost' } } }).prefs?.sort,
    ).toBe('price');
    expect(
      extractRoutingPreferences({ providerOptions: { gateway: { sort: 'tps' } } }).prefs?.sort,
    ).toBe('throughput');
  });

  it('is a no-op without preference fields, and tolerant of garbage', () => {
    const body: Record<string, unknown> = { model: 'm', messages: [] };
    expect(extractRoutingPreferences(body)).toEqual({ prefs: undefined, stripped: false });
    expect(extractRoutingPreferences({ provider: 'anthropic' })).toEqual({
      prefs: undefined,
      stripped: true,
    });
    expect(
      extractRoutingPreferences({ provider: { order: 'x', sort: 'weird', zdr: 'yes' } }).prefs,
    ).toBeUndefined();
  });
});

describe('applyRoutingPreferences', () => {
  const anthropic = t('anthropic', 'anthropic', { zdr: true });
  const bedrock = t('bedrock-us', 'bedrock', { region: 'us-east-1' });
  const azure = t('azure', 'azure', { zdr: true });
  const all = [anthropic, bedrock, azure];
  const rate = (x: RouteTarget) =>
    ({ anthropic: { input: 3, output: 15 }, bedrock: { input: 3.3, output: 16.5 } })[x.provider];

  it('only / ignore filter by provider or target name, case-insensitively', () => {
    expect(applyRoutingPreferences(all, { only: ['bedrock', 'azure'] }).candidates).toEqual([
      bedrock,
      azure,
    ]);
    expect(applyRoutingPreferences(all, { only: ['bedrock-us'] }).candidates).toEqual([bedrock]);
    expect(applyRoutingPreferences(all, { ignore: ['anthropic'] }).candidates).toEqual([
      bedrock,
      azure,
    ]);
    const none = applyRoutingPreferences(all, { only: ['vertex'] });
    expect(none.candidates).toEqual([]);
    expect(none.reason).toMatch(/only=\[vertex\].*available: anthropic, azure, bedrock/);
  });

  it('order promotes the listed targets, keeps the rest unless fallbacks are disabled', () => {
    expect(applyRoutingPreferences(all, { order: ['azure', 'bedrock'] }).candidates).toEqual([
      azure,
      bedrock,
      anthropic,
    ]);
    expect(
      applyRoutingPreferences(all, { order: ['azure'], allowFallbacks: false }).candidates,
    ).toEqual([azure]);
    expect(
      applyRoutingPreferences(all, { order: ['vertex'], allowFallbacks: false }).candidates,
    ).toEqual([]);
    // only ∩ order (Vercel semantics): order within the restricted set.
    expect(
      applyRoutingPreferences(all, { only: ['anthropic', 'bedrock'], order: ['bedrock', 'azure'] })
        .candidates,
    ).toEqual([bedrock, anthropic]);
  });

  it('zdr tightens to ZDR-flagged targets; max_price drops targets over the ceiling or unpriced', () => {
    expect(applyRoutingPreferences(all, { zdr: true }).candidates).toEqual([anthropic, azure]);
    expect(
      applyRoutingPreferences(all, { maxPrice: { prompt: 3 } }, { rateOf: rate }).candidates,
    ).toEqual([anthropic]);
    expect(
      applyRoutingPreferences(all, { maxPrice: { completion: 20 } }, { rateOf: rate }).candidates,
    ).toEqual([anthropic, bedrock]); // azure is unpriced ⇒ excluded
    expect(
      applyRoutingPreferences(all, { maxPrice: { prompt: 1 } }, { rateOf: rate }).reason,
    ).toMatch(/max_price/);
  });

  it('sort by price ranks priced targets ascending (unpriced last); latency/throughput by TTFB, after any `order` head', () => {
    expect(
      applyRoutingPreferences([bedrock, azure, anthropic], { sort: 'price' }, { rateOf: rate })
        .candidates,
    ).toEqual([anthropic, bedrock, azure]);
    const latency = (x: RouteTarget) =>
      ({ anthropic: 900, 'bedrock-us': 300, azure: 0 })[x.name] ?? 0;
    expect(
      applyRoutingPreferences(all, { sort: 'latency' }, { latencyOf: latency }).candidates,
    ).toEqual([azure, bedrock, anthropic]);
    expect(
      applyRoutingPreferences(all, { sort: 'throughput' }, { latencyOf: latency }).candidates,
    ).toEqual([azure, bedrock, anthropic]);
    expect(
      applyRoutingPreferences(
        all,
        { order: ['anthropic'], sort: 'latency' },
        { latencyOf: latency },
      ).candidates,
    ).toEqual([anthropic, azure, bedrock]);
    // No metric source ⇒ the declared order stands.
    expect(applyRoutingPreferences(all, { sort: 'price' }).candidates).toEqual(all);
  });
});
