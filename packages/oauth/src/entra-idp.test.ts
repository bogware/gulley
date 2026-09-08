import { describe, expect, it, vi } from 'vitest';
import { EntraGraphIdp } from './entra-idp';

function fakeGraph(userResponder: (subject: string) => { status: number; body?: unknown }) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/oauth2/v2.0/token')) {
      return new Response(JSON.stringify({ access_token: 'app-tok', expires_in: 3600 }), {
        status: 200,
      });
    }
    // /v1.0/users/<subject>?$select=accountEnabled
    const subject = decodeURIComponent(u.split('/users/')[1]!.split('?')[0]!);
    const r = userResponder(subject);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const base = (fetchImpl: typeof fetch, allowed?: (u: string) => void) =>
  new EntraGraphIdp({
    tenantId: 'tenant-1',
    clientId: 'graph-app',
    clientSecret: 'secret',
    fetchImpl,
    assertAllowed: allowed,
    now: () => 1_000_000,
  });

describe('EntraGraphIdp.isPrincipalActive', () => {
  it('returns true for an enabled directory account', async () => {
    const { fetchImpl } = fakeGraph(() => ({ status: 200, body: { accountEnabled: true } }));
    expect(await base(fetchImpl).isPrincipalActive('oid-1')).toBe(true);
  });

  it('returns false for a disabled account (deprovisioned)', async () => {
    const { fetchImpl } = fakeGraph(() => ({ status: 200, body: { accountEnabled: false } }));
    expect(await base(fetchImpl).isPrincipalActive('oid-1')).toBe(false);
  });

  it('returns false for a deleted account (404)', async () => {
    const { fetchImpl } = fakeGraph(() => ({ status: 404 }));
    expect(await base(fetchImpl).isPrincipalActive('gone')).toBe(false);
  });

  it('caches the app token across calls (one token fetch)', async () => {
    const { fetchImpl, calls } = fakeGraph(() => ({ status: 200, body: { accountEnabled: true } }));
    const idp = base(fetchImpl);
    await idp.isPrincipalActive('a');
    await idp.isPrincipalActive('b');
    expect(calls.filter((c) => c.includes('/oauth2/v2.0/token')).length).toBe(1);
  });

  it('fails closed on a transient Graph error with no cached result', async () => {
    const { fetchImpl } = fakeGraph(() => ({ status: 503 }));
    expect(await base(fetchImpl).isPrincipalActive('oid-1')).toBe(false);
  });

  it('reuses a fresh last-known-good result when Graph is transiently down', async () => {
    let up = true;
    const { fetchImpl } = fakeGraph(() => (up ? { status: 200, body: { accountEnabled: true } } : { status: 503 }));
    const idp = base(fetchImpl);
    expect(await idp.isPrincipalActive('oid-1')).toBe(true); // primes the cache
    up = false;
    expect(await idp.isPrincipalActive('oid-1')).toBe(true); // served from fresh cache
  });

  it('applies the egress guard to both the token and Graph URLs', async () => {
    const seen: string[] = [];
    const { fetchImpl } = fakeGraph(() => ({ status: 200, body: { accountEnabled: true } }));
    await base(fetchImpl, (u) => seen.push(u)).isPrincipalActive('oid-1');
    expect(seen.some((u) => u.includes('login.microsoftonline.com'))).toBe(true);
    expect(seen.some((u) => u.includes('graph.microsoft.com'))).toBe(true);
  });
});
