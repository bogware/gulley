import { describe, expect, it } from 'vitest';
import { fetchDiscovery, OidcProvider } from './discovery';

const ISSUER = 'https://idp.test';

function idp(doc: Record<string, unknown>, seen: string[] = []): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    // Every provider fetch refuses redirects and carries a deadline.
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (url.endsWith('/.well-known/openid-configuration'))
      return new Response(JSON.stringify(doc), { status: 200 });
    if (url.endsWith('/jwks')) return new Response(JSON.stringify({ keys: [] }), { status: 200 });
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
}

const good = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
};

describe('OIDC discovery guard', () => {
  it('accepts a matching issuer (trailing slash tolerated)', async () => {
    const md = await fetchDiscovery(`${ISSUER}/`, idp({ ...good, issuer: `${ISSUER}` }));
    expect(md.token_endpoint).toBe(`${ISSUER}/token`);
  });

  it('rejects a document whose issuer differs from the configured one', async () => {
    await expect(
      fetchDiscovery(ISSUER, idp({ ...good, issuer: 'https://evil.test' })),
    ).rejects.toThrow(/issuer does not match/);
  });

  it('applies the egress guard to the discovery URL, the JWKS URL and every advertised endpoint', async () => {
    const guarded: string[] = [];
    const seen: string[] = [];
    const p = new OidcProvider(ISSUER, {
      fetchImpl: idp(good, seen),
      guard: { assertAllowed: (u) => void guarded.push(u) },
    });
    await p.metadataDoc();
    // A token verify forces the JWKS fetch through the guard too.
    await p.verify('x.y.z', { audience: 'a' });
    expect(guarded).toEqual(
      expect.arrayContaining([
        `${ISSUER}/.well-known/openid-configuration`,
        `${ISSUER}/authorize`,
        `${ISSUER}/token`,
        `${ISSUER}/jwks`,
      ]),
    );
    expect(seen).toContain(`${ISSUER}/jwks`);
  });

  it('a denying guard blocks the fetch before any network call', async () => {
    const seen: string[] = [];
    await expect(
      fetchDiscovery(ISSUER, idp(good, seen), 5_000, {
        assertAllowed: () => {
          throw new Error('egress blocked');
        },
      }),
    ).rejects.toThrow('egress blocked');
    expect(seen).toEqual([]);
  });

  it('requireHttps rejects a plaintext issuer and a plaintext advertised token endpoint', async () => {
    await expect(
      fetchDiscovery('http://idp.test', idp(good), 5_000, { requireHttps: true }),
    ).rejects.toThrow(/must be https/);
    await expect(
      fetchDiscovery(ISSUER, idp({ ...good, token_endpoint: 'http://idp.test/token' }), 5_000, {
        requireHttps: true,
      }),
    ).rejects.toThrow(/token_endpoint must be https/);
  });
});
