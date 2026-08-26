import { OidcProvider } from '@gulley/oidc';
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config';
import { createInMemoryControlContext } from './context';
import { parseRoleMap } from './oidc-gate';
import { buildServer } from './server';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
  kid: 'k1',
  alg: 'RS256',
};
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
function signId(claims: Record<string, unknown>): string {
  const h = b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
  const p = b64(claims);
  const s = createSign('RSA-SHA256')
    .update(`${h}.${p}`)
    .end()
    .sign(privateKey)
    .toString('base64url');
  return `${h}.${p}.${s}`;
}

const ISSUER = 'https://idp.test';
const CLIENT = 'gulley-console';
const SESSION_SECRET = 'oidc-check-session-secret-32-chars-min!!';
let currentNonce = '';

function idpFetch(): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/.well-known/openid-configuration')) {
      return new Response(
        JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
        }),
        { status: 200 },
      );
    }
    if (url.endsWith('/jwks'))
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    if (url.endsWith('/token')) {
      const id_token = signId({
        iss: ISSUER,
        aud: CLIENT,
        sub: 'user-1',
        name: 'Ada',
        groups: ['gulley-admins'],
        nonce: currentNonce,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      return new Response(JSON.stringify({ id_token, access_token: 'at' }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

let app: FastifyInstance;
let gadm: string;

function cookieVal(headers: Record<string, unknown>, name: string): string {
  const sc = headers['set-cookie'];
  const arr = Array.isArray(sc) ? (sc as string[]) : typeof sc === 'string' ? [sc] : [];
  for (const c of arr) {
    const m = new RegExp(`^${name}=([^;]+)`).exec(c);
    if (m?.[1]) return decodeURIComponent(m[1]);
  }
  return '';
}

beforeEach(() => {
  gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  const ctx = createInMemoryControlContext({
    pepper: 'oidc-check-pepper-16chars-min!!',
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: [SESSION_SECRET],
    maxSessionTtlMs: 900_000,
    oidc: {
      provider: new OidcProvider(ISSUER, { fetchImpl: idpFetch() }),
      clientId: CLIENT,
      redirectUri: 'http://localhost:3000/control/auth/callback',
      scopes: 'openid profile email',
      groupsClaim: 'groups',
      roleRules: parseRoleMap('[{"group":"gulley-admins","role":"owner","orgId":"*"}]'),
      postLoginRedirect: '/',
      cookieSecure: false,
      fetchImpl: idpFetch(),
    },
  });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
});

afterEach(async () => {
  await app.close();
});

describe('OIDC session gate', () => {
  it('reports enabled config', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/config' });
    expect(res.json()).toMatchObject({ enabled: true });
  });

  it('runs the full login → callback → session flow and authenticates via the cookie', async () => {
    // Seed an org so the "*" role rule expands to an owner membership.
    const org = await app.inject({
      method: 'POST',
      url: '/orgs',
      headers: { authorization: `Bearer ${gadm}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Acme' }),
    });
    const orgId = (org.json().org as { id: string }).id;

    // 1. login → 302 to the IdP; capture state + nonce + the flow cookie.
    const login = await app.inject({ method: 'GET', url: '/auth/login' });
    expect(login.statusCode).toBe(302);
    const authorize = new URL(login.headers['location'] as string);
    const state = authorize.searchParams.get('state') as string;
    currentNonce = authorize.searchParams.get('nonce') as string;
    const flowCookie = cookieVal(login.headers as Record<string, unknown>, 'gulley_oidc_flow');
    expect(flowCookie).toBeTruthy();

    // 2. callback with the code + state + flow cookie → mints the session cookie.
    const cb = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=abc&state=${state}`,
      headers: { cookie: `gulley_oidc_flow=${encodeURIComponent(flowCookie)}` },
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers['location']).toBe('/');
    const session = cookieVal(cb.headers as Record<string, unknown>, 'gulley_admin_session');
    expect(session).toBeTruthy();

    // 3. /auth/me via the cookie → the OIDC identity + memberships.
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `gulley_admin_session=${encodeURIComponent(session)}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ subject: 'user-1', name: 'Ada' });

    // 4. an admin route authenticates from the same cookie and sees the org.
    const orgs = await app.inject({
      method: 'GET',
      url: '/orgs',
      headers: { cookie: `gulley_admin_session=${encodeURIComponent(session)}` },
    });
    expect(orgs.statusCode).toBe(200);
    expect((orgs.json().orgs as Array<{ id: string }>).some((o) => o.id === orgId)).toBe(true);
  });

  it('rejects a callback with a mismatched state', async () => {
    const login = await app.inject({ method: 'GET', url: '/auth/login' });
    const flowCookie = cookieVal(login.headers as Record<string, unknown>, 'gulley_oidc_flow');
    const cb = await app.inject({
      method: 'GET',
      url: '/auth/callback?code=abc&state=WRONG',
      headers: { cookie: `gulley_oidc_flow=${encodeURIComponent(flowCookie)}` },
    });
    expect(cb.statusCode).toBe(400);
  });

  it('returns 401 from /auth/me without a session', async () => {
    const me = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(me.statusCode).toBe(401);
  });
});
