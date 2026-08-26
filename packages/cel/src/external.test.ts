import { describe, expect, it } from 'vitest';
import { ExternalAuthorizer } from './external';

const activation = (model = 'claude-sonnet-4-6') => ({
  request: { model, provider: 'anthropic' },
  principal: { id: 'vk_1' },
});

const jsonFetch = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('ExternalAuthorizer', () => {
  it('delegates the decision to the policy service', async () => {
    const allow = new ExternalAuthorizer({
      url: 'https://p/authz',
      fetchImpl: jsonFetch({ allow: true }),
    });
    expect(await allow.authorize(activation())).toMatchObject({ allowed: true });

    const deny = new ExternalAuthorizer({
      url: 'https://p/authz',
      fetchImpl: jsonFetch({ allow: false, reason: 'over-budget' }),
    });
    expect(await deny.authorize(activation())).toMatchObject({
      allowed: false,
      reason: 'over-budget',
    });
  });

  it('caches a decision by key within the TTL and refreshes after it', async () => {
    let calls = 0;
    let t = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ allow: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const authz = new ExternalAuthorizer({ url: 'u', ttlMs: 1000, fetchImpl, now: () => t });

    await authz.authorize(activation()); // miss → 1 call
    await authz.authorize(activation()); // hit → still 1
    expect(calls).toBe(1);
    // A different key (different model) misses.
    await authz.authorize(activation('gpt-4o'));
    expect(calls).toBe(2);
    // Past the TTL the original key refreshes.
    t = 1001;
    await authz.authorize(activation());
    expect(calls).toBe(3);
  });

  it('single-flights concurrent misses for the same key', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      await Promise.resolve();
      return new Response(JSON.stringify({ allow: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const authz = new ExternalAuthorizer({ url: 'u', fetchImpl });
    await Promise.all([
      authz.authorize(activation()),
      authz.authorize(activation()),
      authz.authorize(activation()),
    ]);
    expect(calls).toBe(1); // three concurrent callers, one upstream request
  });

  it('applies failMode on error and does NOT cache the fallback', async () => {
    let calls = 0;
    const boom = (async () => {
      calls++;
      return new Response('err', { status: 500 });
    }) as unknown as typeof fetch;

    const closed = new ExternalAuthorizer({ url: 'u', fetchImpl: boom });
    expect(await closed.authorize(activation())).toMatchObject({ allowed: false });
    const open = new ExternalAuthorizer({ url: 'u', failMode: 'allow', fetchImpl: boom });
    expect(await open.authorize(activation())).toMatchObject({ allowed: true });

    // Failures aren't cached: a second call hits the service again.
    calls = 0;
    await closed.authorize(activation());
    await closed.authorize(activation());
    expect(calls).toBe(2);
  });

  it('does NOT reuse a cached decision across differing payloads (default key = full payload)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ allow: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const authz = new ExternalAuthorizer({ url: 'u', fetchImpl });
    // Same principal+model+provider, but a different body ⇒ different key ⇒ the
    // policy is consulted again (no coarse-key authorization bypass).
    await authz.authorize({
      request: { model: 'm', provider: 'p', body: { prompt: 'benign' } },
      principal: { id: 'vk' },
    });
    await authz.authorize({
      request: { model: 'm', provider: 'p', body: { prompt: 'exfiltrate' } },
      principal: { id: 'vk' },
    });
    expect(calls).toBe(2);
  });

  it('honors a custom CEL cache-key expression', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ allow: true }), { status: 200 });
    }) as unknown as typeof fetch;
    // Key on principal only → different models share a cache entry.
    const authz = new ExternalAuthorizer({ url: 'u', cacheKeyExpr: 'principal.id', fetchImpl });
    await authz.authorize(activation('a'));
    await authz.authorize(activation('b')); // same principal → cache hit
    expect(calls).toBe(1);
  });
});
