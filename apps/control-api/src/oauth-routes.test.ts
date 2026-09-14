import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

async function boot(extra: { controlApiPublicUrl?: string; consolePublicUrl?: string } = {}) {
  gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  const ctx = createInMemoryControlContext({
    pepper: 'oauth-routes-pepper-16chars!!!!!',
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: ['oauth-routes-session-secret-32byteslong'],
    maxSessionTtlMs: 900_000,
    oauthBroker: { enabled: true, pepper: 'oauth-routes-pepper-16chars!!!!!', deviceIntervalMs: 0 },
    ...extra,
  });
  app = buildServer(
    loadConfig({ LOG_LEVEL: 'silent', CONTROL_API_TRUST_PROXY_HOPS: '1' } as NodeJS.ProcessEnv),
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
