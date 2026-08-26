import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OidcProvider } from './discovery';
import { type Jwk, type JwtClaims, validateClaims, verifyJwtWithJwks } from './jwt';

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

function rsaKey(): { priv: KeyObject; jwk: Jwk } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid: 'k1', alg: 'RS256' };
  return { priv: privateKey, jwk };
}
function ecKey(): { priv: KeyObject; jwk: Jwk } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid: 'e1', alg: 'ES256' };
  return { priv: privateKey, jwk };
}

function signRs256(claims: JwtClaims, priv: KeyObject, kid = 'k1'): string {
  const h = b64({ alg: 'RS256', typ: 'JWT', kid });
  const p = b64(claims);
  const sig = createSign('RSA-SHA256').update(`${h}.${p}`).end().sign(priv).toString('base64url');
  return `${h}.${p}.${sig}`;
}
function signEs256(claims: JwtClaims, priv: KeyObject, kid = 'e1'): string {
  const h = b64({ alg: 'ES256', typ: 'JWT', kid });
  const p = b64(claims);
  const sig = createSign('SHA256')
    .update(`${h}.${p}`)
    .end()
    .sign({ key: priv, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
  return `${h}.${p}.${sig}`;
}

const CLAIMS: JwtClaims = {
  iss: 'https://idp.example.com',
  aud: 'gulley-console',
  sub: 'user-1',
  name: 'Ada',
  groups: ['gulley-admins'],
  exp: Math.floor(Date.now() / 1000) + 3600,
  nonce: 'n1',
};

describe('verifyJwtWithJwks', () => {
  it('verifies RS256 and ES256 tokens against a JWKS', () => {
    const rsa = rsaKey();
    const ec = ecKey();
    const jwks = [rsa.jwk, ec.jwk];
    expect(verifyJwtWithJwks(signRs256(CLAIMS, rsa.priv), jwks).ok).toBe(true);
    expect(verifyJwtWithJwks(signEs256(CLAIMS, ec.priv), jwks).ok).toBe(true);
  });

  it('rejects a tampered signature and unsupported algorithms', () => {
    const rsa = rsaKey();
    const jwt = signRs256(CLAIMS, rsa.priv);
    const tampered = `${jwt.slice(0, -4)}AAAA`;
    const bad = verifyJwtWithJwks(tampered, [rsa.jwk]);
    expect(bad.ok).toBe(false);

    // A forged "none"/HS256 token must never verify against a JWKS.
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(CLAIMS)}.`;
    expect(verifyJwtWithJwks(none, [rsa.jwk])).toMatchObject({ ok: false });
    const hs = `${b64({ alg: 'HS256', kid: 'k1' })}.${b64(CLAIMS)}.${Buffer.from('x').toString('base64url')}`;
    expect(verifyJwtWithJwks(hs, [rsa.jwk])).toMatchObject({
      ok: false,
      reason: 'unsupported-alg',
    });
  });

  it('fails when no key matches the kid', () => {
    const rsa = rsaKey();
    const other = rsaKey();
    const jwt = signRs256(CLAIMS, rsa.priv, 'unknown-kid');
    expect(verifyJwtWithJwks(jwt, [other.jwk])).toMatchObject({ ok: false });
  });
});

describe('validateClaims', () => {
  const base = { issuer: 'https://idp.example.com', audience: 'gulley-console', now: Date.now() };
  it('accepts good claims and rejects iss/aud/exp/nonce mismatches', () => {
    expect(validateClaims(CLAIMS, { ...base, nonce: 'n1' }).ok).toBe(true);
    expect(validateClaims({ ...CLAIMS, iss: 'evil' }, base)).toMatchObject({ reason: 'iss' });
    expect(validateClaims({ ...CLAIMS, aud: 'other' }, base)).toMatchObject({ reason: 'aud' });
    expect(validateClaims({ ...CLAIMS, exp: 1 }, base)).toMatchObject({ reason: 'expired' });
    expect(validateClaims(CLAIMS, { ...base, nonce: 'wrong' })).toMatchObject({ reason: 'nonce' });
  });
});

describe('OidcProvider', () => {
  it('verifies via cached discovery + JWKS from a mock fetch', async () => {
    const rsa = rsaKey();
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({
            issuer: 'https://idp.example.com',
            authorization_endpoint: 'https://idp.example.com/authorize',
            token_endpoint: 'https://idp.example.com/token',
            jwks_uri: 'https://idp.example.com/jwks',
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ keys: [rsa.jwk] }), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new OidcProvider('https://idp.example.com', { fetchImpl });
    const result = await provider.verify(signRs256(CLAIMS, rsa.priv), {
      audience: 'gulley-console',
      nonce: 'n1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.sub).toBe('user-1');
  });
});
