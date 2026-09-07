import type { RouteTarget } from '@gulley/routing';
import { describe, expect, it } from 'vitest';
import { applyRouteGroups, parseRouteGroups } from './route-groups';
import type { ProviderRoute } from './routes/messages';

const target = (provider: string): RouteTarget => ({
  name: provider,
  provider,
  adapter: {} as RouteTarget['adapter'],
  credential: { scheme: 'bearer', value: 'k' },
  upstreamPath: '/v1/messages',
});
const route = (provider: string, clientPaths: string[]): ProviderRoute => ({
  clientPaths,
  createExtractor: (() => ({})) as ProviderRoute['createExtractor'],
  strategy: { mode: 'single', target: target(provider) },
});
const targetsOf = (r: ProviderRoute): RouteTarget[] =>
  r.strategy.mode === 'single' ? [r.strategy.target] : r.strategy.targets;

describe('parseRouteGroups', () => {
  it('returns [] for empty/undefined', () => {
    expect(parseRouteGroups(undefined)).toEqual([]);
    expect(parseRouteGroups('')).toEqual([]);
  });
  it('parses a valid group and rejects malformed input', () => {
    const g = parseRouteGroups(
      '[{"clientPath":"/v1/messages","mode":"fallback","providers":["a","b"]}]',
    );
    expect(g).toHaveLength(1);
    expect(() =>
      parseRouteGroups('[{"clientPath":"/v1/messages","mode":"nope","providers":["a","b"]}]'),
    ).toThrow();
    // A single-provider group is not multi-target — rejected by the schema (min 2).
    expect(() =>
      parseRouteGroups('[{"clientPath":"/v1/messages","mode":"fallback","providers":["a"]}]'),
    ).toThrow();
  });
});

describe('applyRouteGroups', () => {
  const routes = (): ProviderRoute[] => [
    route('anthropic', ['/v1/messages', '/anthropic/v1/messages']),
    route('bedrock', ['/v1/messages', '/bedrock/v1/messages']),
  ];

  it('folds two single-target routes into a fallback route (winning the path)', () => {
    const out = applyRouteGroups(
      routes(),
      [
        {
          clientPath: '/v1/messages',
          mode: 'fallback',
          providers: ['anthropic', 'bedrock'],
          onStatusCodes: [429],
        },
      ],
      0,
    );
    const group = out[out.length - 1]!;
    expect(group.strategy.mode).toBe('fallback');
    expect(group.strategy).toMatchObject({ onStatusCodes: [429] });
    expect(targetsOf(group).map((t) => t.provider)).toEqual(['anthropic', 'bedrock']);
    expect(group.clientPaths).toContain('/v1/messages'); // inherits the template's paths
  });

  it('stamps a per-provider modelMap for same-model arbitrage', () => {
    const out = applyRouteGroups(
      routes(),
      parseRouteGroups(
        JSON.stringify([
          {
            clientPath: '/v1/messages',
            mode: 'loadbalance',
            select: 'cheapest',
            providers: ['anthropic', 'bedrock'],
            modelMap: { bedrock: { 'claude-sonnet-4-6': 'us.anthropic.claude-sonnet-4-6-v1:0' } },
          },
        ]),
      ),
      0,
    );
    const group = out[out.length - 1]!;
    const byProvider = Object.fromEntries(targetsOf(group).map((t) => [t.provider, t]));
    // The mapped provider carries its upstream-id map; the native provider does not.
    expect(byProvider['bedrock']?.modelMap).toEqual({
      'claude-sonnet-4-6': 'us.anthropic.claude-sonnet-4-6-v1:0',
    });
    expect(byProvider['anthropic']?.modelMap).toBeUndefined();
  });

  it('applies weights for loadbalance and the default hedge', () => {
    const out = applyRouteGroups(
      routes(),
      [
        {
          clientPath: '/v1/messages',
          mode: 'loadbalance',
          providers: ['anthropic', 'bedrock'],
          weights: { anthropic: 3 },
        },
      ],
      400,
    );
    const group = out[out.length - 1]!;
    expect(group.strategy.mode).toBe('loadbalance');
    expect(group.hedgeDelayMs).toBe(400);
    expect(targetsOf(group).find((t) => t.provider === 'anthropic')?.weight).toBe(3);
    expect(targetsOf(group).find((t) => t.provider === 'bedrock')?.weight).toBe(1);
  });

  it('skips a group resolving to <2 configured targets, and one matching no path', () => {
    const base = routes();
    expect(
      applyRouteGroups(
        base,
        [{ clientPath: '/v1/messages', mode: 'fallback', providers: ['anthropic', 'ghost'] }],
        0,
      ),
    ).toHaveLength(base.length); // ghost not configured
    expect(
      applyRouteGroups(
        base,
        [{ clientPath: '/v1/chat/completions', mode: 'fallback', providers: ['a', 'b'] }],
        0,
      ),
    ).toHaveLength(base.length); // no route serves that path
  });
});
