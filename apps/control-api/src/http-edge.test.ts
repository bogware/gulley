import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { buildServer } from './server';

const ORIGIN = 'https://admin.example.com';

function server(env: Record<string, string> = {}): FastifyInstance {
  return buildServer(
    loadConfig({ LOG_LEVEL: 'silent', ADMIN_CORS_ORIGINS: ORIGIN, ...env } as NodeJS.ProcessEnv),
  );
}

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

describe('control-api HTTP edge — CORS', () => {
  it('short-circuits an allowlisted preflight with a 204 + credentials headers', async () => {
    app = server();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it('reflects the allowlisted origin on a real response but never a foreign one', async () => {
    app = server();
    const ok = await app.inject({ method: 'GET', url: '/health', headers: { origin: ORIGIN } });
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ok.headers['vary']).toBe('Origin');

    const foreign = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('control-api HTTP edge — CSRF', () => {
  it('rejects a cookie-authed cross-site unsafe request with 403', async () => {
    app = server();
    const res = await app.inject({
      method: 'POST',
      url: '/orgs',
      headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { type: 'csrf' } });
  });

  it('exempts allowlisted-origin, bearer-authed, and same-origin requests', async () => {
    app = server();
    // Allowlisted origin → CORS-vetted, not CSRF-blocked (reaches routing → 404, no ctx).
    const allowed = await app.inject({
      method: 'POST',
      url: '/nope',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'cross-site' },
    });
    expect(allowed.statusCode).not.toBe(403);
    // Bearer-authed cross-site → not a CSRF vector.
    const bearer = await app.inject({
      method: 'POST',
      url: '/nope',
      headers: { 'sec-fetch-site': 'cross-site', authorization: 'Bearer x' },
    });
    expect(bearer.statusCode).not.toBe(403);
    // Same-origin → allowed.
    const same = await app.inject({
      method: 'POST',
      url: '/nope',
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(same.statusCode).not.toBe(403);
  });

  it('can be disabled via ADMIN_CSRF_ENABLED=false', async () => {
    app = server({ ADMIN_CSRF_ENABLED: 'false' });
    const res = await app.inject({
      method: 'POST',
      url: '/nope',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(res.statusCode).not.toBe(403);
  });
});
