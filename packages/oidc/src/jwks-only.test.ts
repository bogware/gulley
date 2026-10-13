import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fetchJwksUriFromDiscovery, OidcProvider } from './discovery';
import { decodeJwtPayload, type Jwk, type JwtClaims } from './jwt';

/**
 * JWKS-only issuers (Kubernetes service-account issuers, GitHub Actions) publish a
 * discovery document with ONLY `issuer` + `jwks_uri`. The lenient helper and the
 * provider's jwks-only mode must accept them where full OIDC discovery would not.
 */
const ISSUER = 'https://token.actions.githubusercontent.com';
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

function rsaKey(kid = 'gh-1'): { priv: KeyObject; jwk: Jwk } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { priv: privateKey, jwk: { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid } };
}
function sign(claims: JwtClaims, priv: KeyObject, kid = 'gh-1'): string {
  const h = b64({ alg: 'RS256', typ: 'JWT', kid });
  const p = b64(claims);
  const sig = createSign('RSA-SHA256').update(`${h}.${p}`).end().sign(priv).toString('base64url');
  return `${h}.${p}.${sig}`;
}

function githubLike(jwks: Jwk[], seen: string[] = []): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    expect(init?.redirect).toBe('error');
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      // Real shape: no authorization_endpoint / token_endpoint.
      return new Response(
        JSON.stringify({
          issuer: ISSUER,
          jwks_uri: `${ISSUER}/.well-known/jwks`,
          subject_types_supported: ['public'],
          claims_supported: ['sub', 'aud', 'repository'],
        }),
        { status: 200 },
      );
    }
    if (url === `${ISSUER}/.well-known/jwks`)
      return new Response(JSON.stringify({ keys: jwks }), { status: 200 });
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('fetchJwksUriFromDiscovery (lenient)', () => {
  it('accepts a document carrying only issuer + jwks_uri', async () => {
    const seen: string[] = [];
    const uri = await fetchJwksUriFromDiscovery(`${ISSUER}/`, githubLike([], seen));
    expect(uri).toBe(`${ISSUER}/.well-known/jwks`);
    expect(seen).toEqual([`${ISSUER}/.well-known/openid-configuration`]);
  });

  it('still enforces the issuer match and the egress guard on jwks_uri', async () => {
    const evil = (async () =>
      new Response(JSON.stringify({ issuer: 'https://evil.test', jwks_uri: 'https://x/jwks' }), {
        status: 200,
      })) as unknown as typeof fetch;
    await expect(fetchJwksUriFromDiscovery(ISSUER, evil)).rejects.toThrow(/issuer does not match/);
    const guarded: string[] = [];
    await fetchJwksUriFromDiscovery(ISSUER, githubLike([]), 5_000, {
      assertAllowed: (u) => void guarded.push(u),
    });
    expect(guarded).toEqual([
      `${ISSUER}/.well-known/openid-configuration`,
      `${ISSUER}/.well-known/jwks`,
    ]);
    const missing = (async () =>
      new Response(JSON.stringify({ issuer: ISSUER }), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchJwksUriFromDiscovery(ISSUER, missing)).rejects.toThrow(/jwks_uri/);
  });
});

describe('OidcProvider jwks-only mode', () => {
  const now = Math.floor(Date.now() / 1000);
  const claims: JwtClaims = {
    iss: ISSUER,
    aud: 'https://api.gulley.test',
    sub: 'repo:acme/api:ref:refs/heads/main',
    iat: now,
    exp: now + 300,
  };

  it('verifies through lenient discovery, caches the JWKS, and checks iss against the configured issuer', async () => {
    const k = rsaKey();
    const seen: string[] = [];
    const p = new OidcProvider(ISSUER, {
      fetchImpl: githubLike([k.jwk], seen),
      discovery: 'lenient',
    });
    expect(p.jwksOnly).toBe(true);
    const r1 = await p.verify(sign(claims, k.priv), { audience: 'https://api.gulley.test' });
    expect(r1.ok).toBe(true);
    const r2 = await p.verify(sign(claims, k.priv), { audience: 'https://api.gulley.test' });
    expect(r2.ok).toBe(true);
    // One discovery + one JWKS fetch for both verifications.
    expect(seen.filter((u) => u.endsWith('/openid-configuration')).length).toBe(1);
    expect(seen.filter((u) => u.endsWith('/jwks')).length).toBe(1);
    const wrongIss = await p.verify(sign({ ...claims, iss: 'https://other.test' }, k.priv), {
      audience: 'https://api.gulley.test',
    });
    expect(wrongIss).toMatchObject({ ok: false, reason: 'iss' });
    await expect(p.metadataDoc()).rejects.toThrow(/jwks-only/);
  });

  it('a fixed jwksUri skips discovery entirely and refreshes once on an unknown kid', async () => {
    const k1 = rsaKey('k1');
    const k2 = rsaKey('k2');
    let keys = [k1.jwk];
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ keys }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new OidcProvider('https://kubernetes.default.svc', {
      fetchImpl,
      jwksUri: 'https://kubernetes.default.svc/openid/v1/jwks',
    });
    const a = await p.verify(
      sign({ ...claims, iss: 'https://kubernetes.default.svc' }, k1.priv, 'k1'),
      {
        audience: 'https://api.gulley.test',
      },
    );
    expect(a.ok).toBe(true);
    keys = [k1.jwk, k2.jwk]; // rotation
    const b = await p.verify(
      sign({ ...claims, iss: 'https://kubernetes.default.svc' }, k2.priv, 'k2'),
      {
        audience: 'https://api.gulley.test',
      },
    );
    expect(b.ok).toBe(true);
    expect(seen).toEqual([
      'https://kubernetes.default.svc/openid/v1/jwks',
      'https://kubernetes.default.svc/openid/v1/jwks',
    ]);
  });

  it('decodeJwtPayload reads the unverified payload (for issuer routing only)', () => {
    const k = rsaKey();
    expect(decodeJwtPayload(sign(claims, k.priv))?.iss).toBe(ISSUER);
    expect(decodeJwtPayload('not.a.jwt')).toBeNull();
    expect(decodeJwtPayload('nope')).toBeNull();
  });
});
