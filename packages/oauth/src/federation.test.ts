import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { Jwk, JwtClaims } from '@gulley/oidc';
import { describe, expect, it } from 'vitest';
import {
  compileSubjectPattern,
  FederationVerifier,
  JtiReplayCache,
  servicePrincipalId,
  subjectMatches,
  type WorkloadFederation,
} from './federation';

/**
 * The federation verifier over a scripted JWKS: GitHub- and Kubernetes-shaped
 * assertions, every rejection class, replay, and the subject glob semantics.
 */
const GH = 'https://token.actions.githubusercontent.com';
const K8S = 'https://kubernetes.default.svc';
const AUD = 'https://api.gulley.test';
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

function rsaKey(kid: string): { priv: KeyObject; jwk: Jwk } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { priv: privateKey, jwk: { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid } };
}
function sign(claims: JwtClaims, priv: KeyObject, kid: string, alg = 'RS256'): string {
  const h = b64({ alg, typ: 'JWT', kid });
  const p = b64(claims);
  const sig = createSign('RSA-SHA256').update(`${h}.${p}`).end().sign(priv).toString('base64url');
  return `${h}.${p}.${sig}`;
}

const gh = rsaKey('gh');
const k8s = rsaKey('k8s');
const clock = { t: 1_700_000_000_000 };
const nowSec = (): number => Math.floor(clock.t / 1000);

const federations: WorkloadFederation[] = [
  {
    name: 'gh-main',
    issuer: GH,
    subject: { pattern: 'repo:acme/api:ref:refs/heads/main' },
    orgId: 'org_1',
    workspaceId: 'ws_ci',
    scope: { allowedModels: ['claude-sonnet-4-6'] },
    ttlSeconds: 900,
  },
  {
    name: 'gh-prod-env',
    issuer: GH,
    subject: { claims: { repository: 'acme/api', environment: 'prod' } },
    orgId: 'org_1',
    workspaceId: 'ws_prod',
    onBehalfOf: true,
  },
  {
    name: 'k8s-prod',
    issuer: `${K8S}/`,
    jwksUri: `${K8S}/openid/v1/jwks`,
    allowInternal: true,
    audience: ['gulley', AUD],
    subject: { pattern: 'system:serviceaccount:prod:*' },
    orgId: 'org_1',
    workspaceId: 'ws_prod',
    ttlSeconds: 999_999, // clamped to the max
    displayName: 'prod cluster',
  },
];

/** A fetch serving GitHub's lenient discovery document + both issuers' JWKS. */
function fetchImpl(seen: string[] = []): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    seen.push(url);
    if (url === `${GH}/.well-known/openid-configuration`)
      return new Response(JSON.stringify({ issuer: GH, jwks_uri: `${GH}/.well-known/jwks` }), {
        status: 200,
      });
    if (url === `${GH}/.well-known/jwks`)
      return new Response(JSON.stringify({ keys: [gh.jwk] }), { status: 200 });
    if (url === `${K8S}/openid/v1/jwks`)
      return new Response(JSON.stringify({ keys: [k8s.jwk] }), { status: 200 });
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
}

function verifier(opts: { seen?: string[]; guarded?: string[] } = {}): FederationVerifier {
  return new FederationVerifier({
    federations,
    fetchFor: () => fetchImpl(opts.seen),
    assertEgress: (url, fed) => {
      opts.guarded?.push(`${fed.name} ${url}`);
    },
    now: () => clock.t,
  });
}

function ghClaims(over: Partial<JwtClaims> = {}): JwtClaims {
  return {
    iss: GH,
    aud: AUD,
    sub: 'repo:acme/api:ref:refs/heads/main',
    repository: 'acme/api',
    actor: 'octocat',
    ref: 'refs/heads/main',
    iat: nowSec(),
    nbf: nowSec() - 5,
    exp: nowSec() + 300,
    jti: `jti-${Math.random()}`,
    ...over,
  };
}
function k8sClaims(over: Partial<JwtClaims> = {}): JwtClaims {
  return {
    iss: K8S,
    aud: ['gulley'],
    sub: 'system:serviceaccount:prod:builder',
    'kubernetes.io': { namespace: 'prod', serviceaccount: { name: 'builder' } },
    iat: nowSec(),
    exp: nowSec() + 600,
    jti: `jti-${Math.random()}`,
    ...over,
  };
}

describe('subject matching', () => {
  it('`*` is one segment, `**` the rest, everything else literal', () => {
    const one = compileSubjectPattern('system:serviceaccount:prod:*');
    expect(one.test('system:serviceaccount:prod:builder')).toBe(true);
    expect(one.test('system:serviceaccount:prod:builder:extra')).toBe(false);
    expect(one.test('system:serviceaccount:staging:builder')).toBe(false);
    const rest = compileSubjectPattern('repo:acme/api:**');
    expect(rest.test('repo:acme/api:ref:refs/heads/main')).toBe(true);
    expect(rest.test('repo:acme/other:ref:refs/heads/main')).toBe(false);
    expect(
      compileSubjectPattern('repo:acme/*:ref:refs/heads/main').test(
        'repo:acme/x:ref:refs/heads/main',
      ),
    ).toBe(true);
    // Regex metacharacters in the literal part are escaped.
    expect(compileSubjectPattern('a.b').test('axb')).toBe(false);
  });

  it('claims match exactly (array = any of) and combine with a pattern', () => {
    const fed: WorkloadFederation = {
      name: 'f',
      issuer: GH,
      subject: { pattern: 'repo:acme/**', claims: { environment: ['prod', 'canary'] } },
      orgId: 'o',
      workspaceId: 'w',
    };
    expect(subjectMatches(fed, { sub: 'repo:acme/api:x', environment: 'prod' })).toBe(true);
    expect(subjectMatches(fed, { sub: 'repo:acme/api:x', environment: 'dev' })).toBe(false);
    expect(subjectMatches(fed, { sub: 'repo:evil/api:x', environment: 'prod' })).toBe(false);
    expect(subjectMatches(fed, { sub: 'repo:acme/api:x' })).toBe(false); // claim missing
    expect(subjectMatches({ ...fed, subject: {} }, { sub: 'anything' })).toBe(false);
    // A `/` path reads nested claims (Kubernetes projected tokens) — exact key wins.
    const k8s: WorkloadFederation = {
      ...fed,
      subject: {
        claims: {
          'kubernetes.io/namespace': 'prod',
          'kubernetes.io/serviceaccount/name': 'builder',
        },
      },
    };
    const token = {
      sub: 'system:serviceaccount:prod:builder',
      'kubernetes.io': { namespace: 'prod', serviceaccount: { name: 'builder', uid: 'u' } },
    };
    expect(subjectMatches(k8s, token)).toBe(true);
    expect(subjectMatches(k8s, { ...token, 'kubernetes.io': { namespace: 'dev' } })).toBe(false);
    expect(subjectMatches(k8s, { ...token, 'kubernetes.io/namespace': 'dev' })).toBe(false);
  });

  it('shortens + hashes a very long subject in the principal id', () => {
    expect(servicePrincipalId('f', 'short')).toBe('svc:f:short');
    const long = 'x'.repeat(500);
    const id = servicePrincipalId('f', long);
    expect(id.length).toBeLessThanOrEqual('svc:f:'.length + 200);
    expect(id).not.toBe(servicePrincipalId('f', `${long}y`));
  });
});

describe('FederationVerifier', () => {
  it('admits a GitHub-shaped assertion and maps it to the federation scope', async () => {
    const seen: string[] = [];
    const guarded: string[] = [];
    const v = verifier({ seen, guarded });
    // The GitHub federations configure no audience: the broker's public origin is it.
    const r = await v.verify(sign(ghClaims(), gh.priv, 'gh'), { defaultAudience: AUD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      federation: 'gh-main',
      subject: 'repo:acme/api:ref:refs/heads/main',
      principalId: 'svc:gh-main:repo:acme/api:ref:refs/heads/main',
      orgId: 'org_1',
      workspaceId: 'ws_ci',
      scope: { allowedProviders: '*', allowedModels: ['claude-sonnet-4-6'] },
      ttlSeconds: 900,
      onBehalfOf: false,
    });
    expect(r.value.claims['actor']).toBe('octocat');
    // Lenient discovery + JWKS were fetched once, through the egress guard (the JWKS
    // URL is guarded when discovery advertises it AND again when it is fetched).
    expect(seen).toEqual([`${GH}/.well-known/openid-configuration`, `${GH}/.well-known/jwks`]);
    expect(new Set(guarded)).toEqual(
      new Set([`gh-main ${GH}/.well-known/openid-configuration`, `gh-main ${GH}/.well-known/jwks`]),
    );
    // Second assertion: cached keys, no refetch.
    expect((await v.verify(sign(ghClaims(), gh.priv, 'gh'), { defaultAudience: AUD })).ok).toBe(
      true,
    );
    expect(seen.length).toBe(2);
    // Without any audience to expect, nothing can be admitted.
    const noAud = await v.verify(sign(ghClaims(), gh.priv, 'gh'));
    expect(noAud.ok).toBe(false);
    if (!noAud.ok) expect(noAud.error.reason).toBe('aud');
  });

  it('routes a second federation of the same issuer by claims and honours onBehalfOf', async () => {
    const v = verifier();
    const r = await v.verify(
      sign(ghClaims({ sub: 'repo:acme/api:environment:prod', environment: 'prod' }), gh.priv, 'gh'),
      { defaultAudience: AUD },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ federation: 'gh-prod-env', onBehalfOf: true });
  });

  it('admits a Kubernetes-shaped assertion via a fixed JWKS, clamps the TTL, accepts the slash issuer', async () => {
    const v = verifier();
    const r = await v.verify(sign(k8sClaims({ iss: `${K8S}/` }), k8s.priv, 'k8s'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      federation: 'k8s-prod',
      principalId: 'svc:k8s-prod:system:serviceaccount:prod:builder',
      displayName: 'prod cluster',
      ttlSeconds: 86_400,
      workspaceId: 'ws_prod',
    });
    // The default audience is not used when the federation configures its own.
    const noDefault = await v.verify(sign(k8sClaims(), k8s.priv, 'k8s'), {
      defaultAudience: 'https://elsewhere',
    });
    expect(noDefault.ok).toBe(true);
  });

  it('rejects every failure class with a distinct reason', async () => {
    const v = verifier();
    const bad = async (jwt: string, defaultAudience = AUD) => {
      const r = await v.verify(jwt, { defaultAudience });
      return r.ok ? 'ok' : r.error.reason;
    };
    expect(await bad('nope')).toBe('malformed');
    expect(await bad(sign(ghClaims({ iss: 'https://unknown.test' }), gh.priv, 'gh'))).toBe(
      'unknown-issuer',
    );
    expect(await bad(sign(ghClaims({ aud: 'https://other' }), gh.priv, 'gh'))).toBe('aud');
    expect(await bad(sign(ghClaims({ exp: nowSec() - 120 }), gh.priv, 'gh'))).toBe('expired');
    expect(await bad(sign(ghClaims({ nbf: nowSec() + 600 }), gh.priv, 'gh'))).toBe('not-yet-valid');
    expect(await bad(sign(ghClaims({ iat: undefined }), gh.priv, 'gh'))).toBe('iat-missing');
    expect(await bad(sign(ghClaims({ iat: nowSec() + 300 }), gh.priv, 'gh'))).toBe('iat-future');
    expect(await bad(sign(ghClaims({ iat: nowSec() - 700 }), gh.priv, 'gh'))).toBe('iat-stale');
    expect(
      await bad(sign(ghClaims({ sub: 'repo:evil/api:ref:refs/heads/main' }), gh.priv, 'gh')),
    ).toBe('subject-mismatch');
    expect(
      await bad(sign(ghClaims({ sub: 'repo:acme/api:ref:refs/heads/dev' }), gh.priv, 'gh')),
    ).toBe('subject-mismatch');
    // Signed with the wrong key for the kid, no key of the header's type, a forged alg.
    expect(await bad(sign(ghClaims(), k8s.priv, 'gh'))).toBe('bad-signature');
    expect(await bad(sign(ghClaims(), gh.priv, 'gh', 'ES256'))).toBe('no-matching-key');
    const none = `${b64({ alg: 'none' })}.${b64(ghClaims())}.`;
    expect(await bad(none)).toBe('unsupported-alg');
    const hs = `${b64({ alg: 'HS256', kid: 'gh' })}.${b64(ghClaims())}.${b64('x')}`;
    expect(await bad(hs)).toBe('unsupported-alg');
    // No audience anywhere → cannot be satisfied.
    expect(await bad(sign(ghClaims(), gh.priv, 'gh'), '')).toBe('aud');
  });

  it('rejects a replayed jti and a replayed jti-less token; a JWKS outage is jwks-unavailable', async () => {
    const v = verifier();
    const aud = { defaultAudience: AUD };
    const jwt = sign(ghClaims({ jti: 'once' }), gh.priv, 'gh');
    expect((await v.verify(jwt, aud)).ok).toBe(true);
    const again = await v.verify(jwt, aud);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.reason).toBe('replayed');
    // Same jti on a different (valid) token is still a replay for that issuer.
    const twin = await v.verify(
      sign(ghClaims({ jti: 'once', actor: 'other' }), gh.priv, 'gh'),
      aud,
    );
    expect(twin.ok).toBe(false);
    const noJti = sign(ghClaims({ jti: undefined }), gh.priv, 'gh');
    expect((await v.verify(noJti, aud)).ok).toBe(true);
    expect((await v.verify(noJti, aud)).ok).toBe(false);
    // After the token's own expiry the replay entry lapses (it is invalid anyway).
    clock.t += 400_000;
    const late = await v.verify(jwt, aud);
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.reason).toBe('expired');
    clock.t -= 400_000;

    const down = new FederationVerifier({
      federations,
      fetchFor: () => (async () => new Response('x', { status: 503 })) as unknown as typeof fetch,
      now: () => clock.t,
    });
    const r = await down.verify(sign(ghClaims(), gh.priv, 'gh'), aud);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('jwks-unavailable');
  });

  it('the replay cache is bounded and evicts expired-then-oldest entries', () => {
    const c = new JtiReplayCache(3);
    c.add('a', 100, 0);
    c.add('b', 100, 0);
    c.add('c', 100, 0);
    expect(c.size).toBe(3);
    c.add('d', 100, 0); // full, nothing expired → oldest (a) evicted
    expect(c.has('a', 0)).toBe(false);
    expect(c.has('d', 0)).toBe(true);
    expect(c.size).toBe(3);
    c.add('e', 500, 200); // b, c, d expired at 100 → swept first
    expect(c.size).toBe(1);
    expect(c.has('e', 200)).toBe(true);
    expect(c.has('e', 600)).toBe(false);
  });
});
