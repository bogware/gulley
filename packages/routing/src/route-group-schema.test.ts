import { describe, expect, it } from 'vitest';
import { routeGroupListSchema, routeGroupSchema } from './route-group-schema';

const base = { clientPath: '/v1/messages', mode: 'fallback', providers: ['anthropic', 'bedrock'] };

describe('routeGroupSchema', () => {
  it('accepts a minimal group and every optional knob, including a descriptive name', () => {
    expect(routeGroupSchema.safeParse(base).success).toBe(true);
    const full = routeGroupSchema.safeParse({
      ...base,
      name: 'messages-ha',
      mode: 'loadbalance',
      select: 'cheapest',
      weights: { anthropic: 3, bedrock: 1 },
      onStatusCodes: [429, 503],
      hedgeDelayMs: 250,
      modelMap: { bedrock: { 'claude-sonnet-4-6': 'us.anthropic.claude-sonnet-4-6-v1:0' } },
    });
    expect(full.success).toBe(true);
    if (full.success) expect(full.data.name).toBe('messages-ha');
  });

  it('rejects a single-provider group, an unknown mode/select and out-of-range numbers', () => {
    const bad = (over: Record<string, unknown>) =>
      routeGroupSchema.safeParse({ ...base, ...over }).success;
    expect(bad({ providers: ['anthropic'] })).toBe(false); // nothing to fail over between
    expect(bad({ mode: 'conditional' })).toBe(false);
    expect(bad({ select: 'random' })).toBe(false);
    expect(bad({ weights: { anthropic: 0 } })).toBe(false); // weights are positive
    expect(bad({ hedgeDelayMs: -1 })).toBe(false);
    expect(bad({ onStatusCodes: [429.5] })).toBe(false);
    expect(bad({ clientPath: '' })).toBe(false);
    expect(bad({ name: '' })).toBe(false);
  });

  it('names the failing field in its issues (what the console and GitOps surface)', () => {
    const r = routeGroupSchema.safeParse({ ...base, providers: ['anthropic'] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['providers']);
  });

  it('parses the env ROUTE_GROUPS list shape', () => {
    expect(routeGroupListSchema.safeParse([base, { ...base, mode: 'loadbalance' }]).success).toBe(
      true,
    );
    expect(routeGroupListSchema.safeParse(base).success).toBe(false); // must be an array
  });
});

describe('routeGroupSchema — onStatusCodes bound', () => {
  it('accepts 408/409/429/5xx and rejects a terminal client error', () => {
    const base = {
      clientPath: '/v1/messages',
      mode: 'fallback',
      providers: ['anthropic', 'bedrock'],
    };
    expect(
      routeGroupSchema.safeParse({ ...base, onStatusCodes: [408, 409, 429, 500, 529] }).success,
    ).toBe(true);
    const bad = routeGroupSchema.safeParse({ ...base, onStatusCodes: [418] });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(JSON.stringify(bad.error.issues)).toMatch(/408, 409, 429 or a 5xx/);
    expect(routeGroupSchema.safeParse({ ...base, onStatusCodes: [404] }).success).toBe(false);
  });
});
