import type { ConfigDocument, ConfigEntity } from '@gulley/config';
import { describe, expect, it } from 'vitest';
import { parseSmartRoutingPolicies, parseSmartRoutingPolicyConfig } from './smart-routing-config';

describe('parseSmartRoutingPolicyConfig', () => {
  it('parses a valid policy and defaults an omitted selector to {}', () => {
    const cfg = parseSmartRoutingPolicyConfig({
      objective: 'cost-tier',
      classifier: { mode: 'rules-then-llm', rules: [{ category: 'cheap', maxChars: 200 }] },
      categoryRoutes: { cheap: 'small', hard: 'frontier' },
    });
    expect(cfg.selector).toEqual({});
    expect(cfg.classifier.mode).toBe('rules-then-llm');
  });

  it('rejects an unknown objective, an unknown classifier mode, and unknown keys', () => {
    expect(() =>
      parseSmartRoutingPolicyConfig({
        objective: 'bogus',
        classifier: { mode: 'rules-then-llm' },
        categoryRoutes: {},
      }),
    ).toThrow();
    expect(() =>
      parseSmartRoutingPolicyConfig({
        objective: 'cost-tier',
        classifier: { mode: 'nope' },
        categoryRoutes: {},
      }),
    ).toThrow();
    // .strict(): an unexpected key (e.g. a smuggled inline secret) is rejected.
    expect(() =>
      parseSmartRoutingPolicyConfig({
        objective: 'cost-tier',
        classifier: { mode: 'llm-router', apiKey: 'x' },
        categoryRoutes: {},
      }),
    ).toThrow();
  });
});

const doc = (policies: ConfigEntity[] | undefined): ConfigDocument => ({
  apiVersion: 'gulley/v1',
  orgs: [
    {
      name: 'o',
      workspaces: [
        {
          name: 'w',
          providers: [],
          routes: [],
          policies: [],
          budgets: [],
          rateLimits: [],
          guardrails: [],
          modelAliases: [],
          virtualKeys: [],
          ...(policies !== undefined ? { smartRoutingPolicies: policies } : {}),
        },
      ],
    },
  ],
});

describe('parseSmartRoutingPolicies', () => {
  it('extracts typed policies, carrying name/selector/priority', () => {
    const out = parseSmartRoutingPolicies(
      doc([
        {
          name: 'p1',
          config: {
            objective: 'safety-risk',
            classifier: { mode: 'embedding-nearest-label', labels: ['safe', 'risky'] },
            categoryRoutes: { safe: 'a', risky: 'b' },
            selector: { user: 'u1' },
            priority: 3,
          },
        },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe('p1');
    expect(out[0]?.selector).toEqual({ user: 'u1' });
    expect(out[0]?.priority).toBe(3);
  });

  it('throws (rejecting the reconcile) on a malformed policy', () => {
    expect(() =>
      parseSmartRoutingPolicies(doc([{ name: 'bad', config: { objective: 'cost-tier' } }])),
    ).toThrow();
  });

  it('returns [] when a workspace has no policies', () => {
    expect(parseSmartRoutingPolicies(doc(undefined))).toEqual([]);
  });
});
