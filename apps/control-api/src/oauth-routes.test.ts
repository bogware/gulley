import {
  createHash,
  createSign,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
} from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  FederationVerifier,
  type FederationVerifierPort,
  type WorkloadFederation,
} from '@gulley/oauth';
import type { Jwk, JwtClaims } from '@gulley/oidc';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { createInMemoryControlContext } from './context';
import { buildServer } from './server';

/**
 * The broker's HTTP surface as a coding harness uses it: RFC 8414 discovery,
 * form-encoded token requests, the RFC 8628 grant-type URN, absolute verification
 * URIs, the consent page + preview + deny, and cache headers.
 */
let app: FastifyInstance;
let gadm: string;

const admin = () => ({ authorization: `Bearer ${gadm}` });
const json = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(payload),
  });
const form = (url: string, fields: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    payload: new URLSearchParams(fields).toString(),
  });

async function boot(
  extra: {
    controlApiPublicUrl?: string;
    consolePublicUrl?: string;
    federation?: FederationVerifierPort;
    env?: Record<string, string>;
  } = {},
) {
  gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  const { federation, env, ...ctxExtra } = extra;
  const ctx = createInMemoryControlContext({
    pepper: 'oauth-routes-pepper-16chars!!!!!',
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: ['oauth-routes-session-secret-32byteslong'],
    maxSessionTtlMs: 900_000,
    oauthBroker: {
      enabled: true,
      pepper: 'oauth-routes-pepper-16chars!!!!!',
      deviceIntervalMs: 0,
      federation,
    },
    ...ctxExtra,
  });
  app = buildServer(
    loadConfig({
      LOG_LEVEL: 'silent',
      CONTROL_API_TRUST_PROXY_HOPS: '1',
      ...env,
    } as NodeJS.ProcessEnv),
    ctx,
  );
  // An org + workspace, then a registered device-capable client (in-memory broker
  // stores are seeded through the broker's client store since there is no DB).
  const org = (
    (await json('/orgs', { name: 'Acme' }, admin()).then((r) => r.json())) as {
      org: { id: string };
    }
  ).org;
  const ws = (
    (await json('/workspaces', { orgId: org.id, name: 'prod' }, admin()).then((r) => r.json())) as {
      workspace: { id: string };
    }
  ).workspace;
  const clients = (
    ctx.oauthBroker as unknown as {
      deps: { clients: { add(c: unknown): void } };
    }
  ).deps.clients;
  clients.add({
    clientId: 'claude-code',
    name: 'Claude Code',
    orgId: org.id,
    workspaceId: ws.id,
    grantTypes: ['device_code', 'authorization_code', 'refresh_token'],
    redirectAllowlist: ['/callback'],
    enabled: true,
  });
  return { ctx, org, ws };
}

afterEach(async () => {
  await app.close();
});

describe('OAuth broker HTTP surface (harness-facing)', () => {
  beforeEach(async () => {
    await boot({ controlApiPublicUrl: 'https://api.gulley.test' });
  });

  it('publishes RFC 8414 metadata rooted at the configured public origin', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    expect(res.statusCode).toBe(200);
    const meta = res.json() as Record<string, unknown>;
    expect(meta['issuer']).toBe('https://api.gulley.test');
    expect(meta['token_endpoint']).toBe('https://api.gulley.test/oauth/token');
    expect(meta['device_authorization_endpoint']).toBe(
      'https://api.gulley.test/oauth/device_authorization',
    );
    expect(meta['grant_types_supported']).toContain('urn:ietf:params:oauth:grant-type:device_code');
    expect(meta['code_challenge_methods_supported']).toEqual(['S256']);
    expect(meta['introspection_endpoint']).toBe('https://api.gulley.test/oauth/introspect');
    expect(meta['device_verification_uri']).toBe('https://api.gulley.test/oauth/device');
  });

  it('runs the whole device flow over form-encoded requests with the RFC grant-type URN', async () => {
    const da = await form('/oauth/device_authorization', { client_id: 'claude-code' });
    expect(da.statusCode).toBe(200);
    expect(da.headers['cache-control']).toBe('no-store');
    const d = da.json() as Record<string, string>;
    // Absolute verification URIs (RFC 8628 §3.2) — the old relative `/oauth/device`
    // could not be opened by a user.
    expect(d['verification_uri']).toBe('https://api.gulley.test/oauth/device');
    expect(d['verification_uri_complete']).toBe(
      `https://api.gulley.test/oauth/device?user_code=${encodeURIComponent(d['user_code']!)}`,
    );
    const pending = await form('/oauth/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: d['device_code']!,
      client_id: 'claude-code',
    });
    expect(pending.statusCode).toBe(400);
    expect((pending.json() as { error: string }).error).toBe('authorization_pending');
    expect(pending.headers['cache-control']).toBe('no-store');

    // The consent page previews the client/tenancy and takes the code typed loosely.
    const preview = await app.inject({
      method: 'GET',
      url: `/oauth/device/preview?user_code=${d['user_code']!.toLowerCase().replace('-', '')}`,
      headers: admin(),
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      clientId: 'claude-code',
      clientName: 'Claude Code',
      orgName: 'Acme',
      workspaceName: 'prod',
      userCode: d['user_code'],
    });
    const approve = await json('/oauth/device/authorize', { user_code: d['user_code'] }, admin());
    expect(approve.statusCode).toBe(200);

    const tok = await form('/oauth/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: d['device_code']!,
      client_id: 'claude-code',
    });
    expect(tok.statusCode).toBe(200);
    const t = tok.json() as Record<string, string>;
    expect(t['access_token']).toMatch(/^gko_at_/);
    expect(t['refresh_token']).toMatch(/^gko_rt_/);

    // RFC 7662 introspection answers for the token the caller holds.
    const active = await form('/oauth/introspect', { token: t['access_token']! });
    expect(active.statusCode).toBe(200);
    expect(active.json()).toMatchObject({ active: true, client_id: 'claude-code' });
    expect(active.headers['cache-control']).toBe('no-store');
    expect((await form('/oauth/introspect', { token: 'gko_at_nope.secret' })).json()).toEqual({
      active: false,
    });

    // Refresh over form encoding rotates; the short grant-type spelling still works.
    const rot = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: t['refresh_token']!,
      client_id: 'claude-code',
    });
    expect(rot.statusCode).toBe(200);
    // Rotation invalidates the previous access token, and introspection says so.
    expect((await form('/oauth/introspect', { token: t['access_token']! })).json()).toEqual({
      active: false,
    });
    const legacy = await json('/oauth/token', {
      grant_type: 'device_code',
      device_code: d['device_code'],
      client_id: 'claude-code',
    });
    expect(legacy.statusCode).toBe(400); // already redeemed → invalid_grant (not 415/unsupported)
    expect((legacy.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('a denial at the consent page yields access_denied to the poller; unknown client is 401', async () => {
    const d = (
      await form('/oauth/device_authorization', { client_id: 'claude-code' })
    ).json() as Record<string, string>;
    const deny = await json('/oauth/device/deny', { user_code: d['user_code'] }, admin());
    expect(deny.statusCode).toBe(200);
    const poll = await form('/oauth/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: d['device_code']!,
      client_id: 'claude-code',
    });
    expect(poll.statusCode).toBe(400);
    expect((poll.json() as { error: string }).error).toBe('access_denied');

    const unknown = await form('/oauth/device_authorization', { client_id: 'nope' });
    expect(unknown.statusCode).toBe(401);
    expect((unknown.json() as { error: string; error_description: string }).error).toBe(
      'invalid_client',
    );
    expect((unknown.json() as { error_description: string }).error_description).toContain(
      'registers clients',
    );
  });

  it('consent endpoints require an admin identity (no client-supplied identity)', async () => {
    const d = (
      await form('/oauth/device_authorization', { client_id: 'claude-code' })
    ).json() as Record<string, string>;
    const anon = await json('/oauth/device/authorize', { user_code: d['user_code'] });
    expect(anon.statusCode).toBe(401);
    const preview = await app.inject({
      method: 'GET',
      url: `/oauth/device/preview?user_code=${d['user_code']}`,
    });
    expect(preview.statusCode).toBe(401);
  });

  it('serves a hardened consent page that never interpolates the user code server-side', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/oauth/device?user_code=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).not.toContain('<script>alert');
    expect(res.body).toContain('/oauth/device/authorize');
    expect(res.body).toContain('/oauth/device/deny');
  });

  it('rejects an unsupported grant type with a description', async () => {
    const res = await form('/oauth/token', { grant_type: 'password', client_id: 'claude-code' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'unsupported_grant_type' });
  });

  it('without workload federations the jwt-bearer grant is unsupported and not advertised', async () => {
    const meta = (
      await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })
    ).json() as { grant_types_supported: string[] };
    expect(meta.grant_types_supported).not.toContain(JWT_BEARER);
    const res = await form('/oauth/token', { grant_type: JWT_BEARER, assertion: 'a.b.c' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'unsupported_grant_type' });
  });
});

/**
 * RFC 7523 JWT-bearer (workload identity) end to end: a LOCAL JWKS server stands in
 * for GitHub's token issuer (lenient discovery document) and a Kubernetes API server
 * (fixed JWKS URI); assertions are RSA-signed in the shapes those platforms emit.
 */
const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const ORIGIN = 'https://api.gulley.test';
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

function rsaKey(kid: string): { priv: KeyObject; jwk: Jwk } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { priv: privateKey, jwk: { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid } };
}
function sign(claims: JwtClaims, priv: KeyObject, kid: string): string {
  const h = b64({ alg: 'RS256', typ: 'JWT', kid });
  const p = b64(claims);
  const sig = createSign('RSA-SHA256').update(`${h}.${p}`).end().sign(priv).toString('base64url');
  return `${h}.${p}.${sig}`;
}

describe('RFC 7523 JWT-bearer workload identity exchange (local JWKS server)', () => {
  const gh = rsaKey('gh-1');
  const k8s = rsaKey('k8s-1');
  let jwks: Server;
  let base: string;
  let ghIssuer: string;
  let k8sIssuer: string;
  let federations: WorkloadFederation[];

  beforeAll(async () => {
    jwks = createServer((req, res) => {
      const send = (body: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/gh/.well-known/openid-configuration') {
        // GitHub's real document carries no authorization/token endpoints.
        return send({ issuer: ghIssuer, jwks_uri: `${base}/gh/.well-known/jwks` });
      }
      if (req.url === '/gh/.well-known/jwks') return send({ keys: [gh.jwk] });
      if (req.url === '/k8s/openid/v1/jwks') return send({ keys: [k8s.jwk] });
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;
    ghIssuer = `${base}/gh`;
    k8sIssuer = `${base}/k8s`;
    federations = [
      {
        name: 'gh-main',
        issuer: ghIssuer,
        subject: { pattern: 'repo:acme/api:ref:refs/heads/main' },
        orgId: 'org_ci',
        workspaceId: 'ws_ci',
        scope: { allowedProviders: ['anthropic'], allowedModels: ['claude-sonnet-4-6'] },
        ttlSeconds: 900,
      },
      {
        name: 'k8s-prod',
        issuer: k8sIssuer,
        jwksUri: `${k8sIssuer}/openid/v1/jwks`,
        allowInternal: true,
        audience: 'gulley',
        subject: { claims: { 'kubernetes.io/namespace': 'prod' } },
        orgId: 'org_prod',
        workspaceId: 'ws_prod',
        onBehalfOf: true,
      },
    ];
  });
  afterAll(async () => {
    await new Promise<void>((r) => jwks.close(() => r()));
  });

  const verifier = (): FederationVerifier =>
    new FederationVerifier({
      federations,
      // The test issuer is loopback: a real deployment routes public issuers through
      // the SSRF-guarded pinned fetch and marks in-cluster ones allowInternal.
      fetchFor: () => fetch,
      assertEgress: () => {},
    });

  const now = (): number => Math.floor(Date.now() / 1000);
  const ghClaims = (over: Partial<JwtClaims> = {}): JwtClaims => ({
    iss: ghIssuer,
    aud: ORIGIN,
    sub: 'repo:acme/api:ref:refs/heads/main',
    repository: 'acme/api',
    repository_owner: 'acme',
    actor: 'octocat',
    ref: 'refs/heads/main',
    workflow: 'deploy',
    iat: now(),
    nbf: now() - 5,
    exp: now() + 300,
    jti: randomBytes(8).toString('hex'),
    ...over,
  });
  const k8sClaims = (over: Partial<JwtClaims> = {}): JwtClaims => ({
    iss: k8sIssuer,
    aud: ['gulley'],
    sub: 'system:serviceaccount:prod:builder',
    'kubernetes.io': {
      namespace: 'prod',
      serviceaccount: { name: 'builder', uid: '2b5d1c8e' },
      pod: { name: 'builder-7d9f', uid: 'c0ffee' },
    },
    iat: now(),
    exp: now() + 3600,
    jti: randomBytes(8).toString('hex'),
    ...over,
  });

  it('exchanges a GitHub-shaped assertion for a scoped, access-only token; introspection shows the service identity', async () => {
    const { ctx } = await boot({ controlApiPublicUrl: ORIGIN, federation: verifier() });
    const meta = (
      await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })
    ).json() as { grant_types_supported: string[] };
    expect(meta.grant_types_supported).toContain(JWT_BEARER);

    const res = await form('/oauth/token', {
      grant_type: JWT_BEARER,
      assertion: sign(ghClaims(), gh.priv, 'gh-1'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const t = res.json() as Record<string, unknown>;
    expect(t['access_token']).toMatch(/^gko_at_/);
    expect(t['token_type']).toBe('Bearer');
    expect(t['expires_in']).toBe(900);
    expect(t).not.toHaveProperty('refresh_token');

    const intro = (await form('/oauth/introspect', { token: t['access_token'] as string })).json();
    expect(intro).toMatchObject({
      active: true,
      client_id: 'workload',
      sub: 'svc:gh-main:repo:acme/api:ref:refs/heads/main',
      kind: 'service',
      federation: 'gh-main',
      subject: 'repo:acme/api:ref:refs/heads/main',
      scope: { allowedProviders: ['anthropic'], allowedModels: ['claude-sonnet-4-6'] },
      on_behalf_of: false,
    });
    // The data-plane resolver sees a service principal with the stored scope.
    const p = await ctx.oauthBroker!.resolveBrokerToken(t['access_token'] as string);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.value.serviceAccount).toBe('gh-main');
      expect(p.value.userId).toBeUndefined();
      expect(p.value.scope).toMatchObject({ orgId: 'org_ci', workspaceId: 'ws_ci' });
    }
    // Audited, with the identity (never the assertion).
    const rows = await ctx.auditByAction('oauth.token_exchanged', 5);
    expect(rows[0]).toMatchObject({
      actor: 'svc:gh-main:repo:acme/api:ref:refs/heads/main',
      payload: { federation: 'gh-main', clientId: 'workload', workspaceId: 'ws_ci' },
    });
    // A service token cannot be refreshed (there is no refresh token to begin with).
    const handle = (t['access_token'] as string).slice('gko_at_'.length).split('.')[0]!;
    const refresh = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: `gko_rt_${handle}.0.${'q'.repeat(43)}`,
      client_id: 'workload',
    });
    expect(refresh.statusCode).toBe(400);
    expect(refresh.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('exchanges a Kubernetes-shaped assertion (fixed JWKS, kubernetes.io claims, onBehalfOf)', async () => {
    await boot({ controlApiPublicUrl: ORIGIN, federation: verifier() });
    const res = await form('/oauth/token', {
      grant_type: JWT_BEARER,
      assertion: sign(k8sClaims(), k8s.priv, 'k8s-1'),
    });
    expect(res.statusCode).toBe(200);
    const t = res.json() as Record<string, unknown>;
    expect(t['expires_in']).toBe(3600);
    expect(t).not.toHaveProperty('refresh_token');
    expect(
      (await form('/oauth/introspect', { token: t['access_token'] as string })).json(),
    ).toMatchObject({
      active: true,
      kind: 'service',
      federation: 'k8s-prod',
      sub: 'svc:k8s-prod:system:serviceaccount:prod:builder',
      subject: 'system:serviceaccount:prod:builder',
      scope: { allowedProviders: '*', allowedModels: '*' },
      on_behalf_of: true,
    });
    // Another namespace is not admitted by the claims rule.
    const staging = await form('/oauth/token', {
      grant_type: JWT_BEARER,
      assertion: sign(
        k8sClaims({
          sub: 'system:serviceaccount:staging:builder',
          'kubernetes.io': { namespace: 'staging', serviceaccount: { name: 'builder' } },
        }),
        k8s.priv,
        'k8s-1',
      ),
    });
    expect(staging.statusCode).toBe(400);
    expect(staging.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('every verification failure is a generic 400 invalid_grant that never echoes the token', async () => {
    await boot({ controlApiPublicUrl: ORIGIN, federation: verifier() });
    const cases: Array<[string, string]> = [
      ['wrong aud', sign(ghClaims({ aud: 'https://elsewhere' }), gh.priv, 'gh-1')],
      ['expired', sign(ghClaims({ exp: now() - 300 }), gh.priv, 'gh-1')],
      ['future iat', sign(ghClaims({ iat: now() + 600 }), gh.priv, 'gh-1')],
      ['stale iat', sign(ghClaims({ iat: now() - 1200 }), gh.priv, 'gh-1')],
      ['unknown issuer', sign(ghClaims({ iss: 'https://unknown.test' }), gh.priv, 'gh-1')],
      [
        'subject mismatch',
        sign(ghClaims({ sub: 'repo:acme/api:ref:refs/heads/dev' }), gh.priv, 'gh-1'),
      ],
      ['wrong key', sign(ghClaims(), k8s.priv, 'gh-1')],
      ['malformed', 'not-a-jwt'],
    ];
    for (const [label, assertion] of cases) {
      const res = await form('/oauth/token', { grant_type: JWT_BEARER, assertion });
      expect(res.statusCode, label).toBe(400);
      const body = res.json() as { error: string; error_description: string };
      expect(body.error, label).toBe('invalid_grant');
      expect(body.error_description, label).toBe(
        'the grant is invalid, expired, revoked, or was already used',
      );
      expect(res.body, label).not.toContain(assertion.slice(0, 40));
    }
    // Replay: the same assertion is accepted once.
    const once = sign(ghClaims({ jti: 'replay-me' }), gh.priv, 'gh-1');
    expect(
      (await form('/oauth/token', { grant_type: JWT_BEARER, assertion: once })).statusCode,
    ).toBe(200);
    const replay = await form('/oauth/token', { grant_type: JWT_BEARER, assertion: once });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({ error: 'invalid_grant' });
    // Missing assertion is a malformed request, not a grant failure.
    expect((await form('/oauth/token', { grant_type: JWT_BEARER })).json()).toMatchObject({
      error: 'invalid_request',
    });
    // An unknown client_id is invalid_client (401), a device-only client too.
    const unknown = await form('/oauth/token', {
      grant_type: JWT_BEARER,
      assertion: sign(ghClaims(), gh.priv, 'gh-1'),
      client_id: 'nope',
    });
    expect(unknown.statusCode).toBe(401);
    const deviceOnly = await form('/oauth/token', {
      grant_type: JWT_BEARER,
      assertion: sign(ghClaims(), gh.priv, 'gh-1'),
      client_id: 'claude-code',
    });
    expect(deviceOnly.statusCode).toBe(401);
  });

  it('the token exchange draws on its own per-IP budget, separate from the auth-surface one', async () => {
    await boot({
      controlApiPublicUrl: ORIGIN,
      federation: verifier(),
      env: {
        CONTROL_API_AUTH_RATE_LIMIT_PER_MIN: '2',
        CONTROL_API_TOKEN_EXCHANGE_RATE_LIMIT_PER_MIN: '3',
      },
    });
    const exchange = () =>
      form('/oauth/token', {
        grant_type: JWT_BEARER,
        assertion: sign(ghClaims(), gh.priv, 'gh-1'),
      });
    const login = () => form('/oauth/device_authorization', { client_id: 'claude-code' });
    // Two logins fit the auth budget; the third is shed.
    expect((await login()).statusCode).toBe(200);
    expect((await login()).statusCode).toBe(200);
    const shed = await login();
    expect(shed.statusCode).toBe(429);
    expect(shed.headers['retry-after']).toBe('60');
    // The exhausted auth budget does not touch the exchange budget: 3 exchanges still fit.
    expect((await exchange()).statusCode).toBe(200);
    expect((await exchange()).statusCode).toBe(200);
    expect((await exchange()).statusCode).toBe(200);
    expect((await exchange()).statusCode).toBe(429);
    // A non-jwt-bearer token request is still judged by the (exhausted) auth budget.
    const refresh = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: 'gko_rt_x.1.y',
      client_id: 'claude-code',
    });
    expect(refresh.statusCode).toBe(429);
  });
});

describe('public-origin derivation', () => {
  it('derives the issuer from the proxy-trusted request when no public URL is configured, and prefers the console for consent', async () => {
    await boot({ consolePublicUrl: 'https://console.gulley.test/' });
    const meta = (
      await app.inject({
        method: 'GET',
        url: '/.well-known/oauth-authorization-server',
        headers: { host: 'api.internal:8081', 'x-forwarded-proto': 'https' },
        remoteAddress: '127.0.0.1',
      })
    ).json() as Record<string, string>;
    expect(meta['issuer']).toBe('https://api.internal:8081');
    expect(meta['device_verification_uri']).toBe('https://console.gulley.test/oauth/device');
    const d = (
      await form('/oauth/device_authorization', { client_id: 'claude-code' })
    ).json() as Record<string, string>;
    expect(d['verification_uri']).toBe('https://console.gulley.test/oauth/device');
  });
});
