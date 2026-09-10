import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Config, loadConfig } from './config';
import { createInMemoryControlContext } from './context';
import { redactConfig } from './debug-routes';
import { buildServer } from './server';

describe('redactConfig', () => {
  it('masks secret-bearing keys, strips URL credentials, keeps operational knobs', () => {
    const cfg = {
      LOG_LEVEL: 'info',
      GULLEY_KEY_PEPPER: 'super-secret-pepper-value',
      GULLEY_ADMIN_SESSION_SECRET: 'a'.repeat(40),
      GULLEY_ADMIN_SESSION_SECRET_PREV: '',
      OIDC_CLIENT_SECRET: 'client-secret',
      SOME_DATABASE_URL: 'postgres://user:pass@db.internal:5432/gulley',
      ADMIN_CORS_ORIGINS: 'https://admin.example.com',
    } as unknown as Config;
    const out = redactConfig(cfg);
    expect(out['LOG_LEVEL']).toBe('info');
    expect(out['ADMIN_CORS_ORIGINS']).toBe('https://admin.example.com');
    expect(out['GULLEY_KEY_PEPPER']).toBe('<set>');
    expect(out['GULLEY_ADMIN_SESSION_SECRET']).toBe('<set>');
    expect(out['GULLEY_ADMIN_SESSION_SECRET_PREV']).toBe('<unset>');
    expect(out['OIDC_CLIENT_SECRET']).toBe('<set>');
    expect(out['SOME_DATABASE_URL']).toBe('postgres://db.internal:5432/gulley'); // creds stripped
    // No secret value survives anywhere in the dump.
    expect(JSON.stringify(out)).not.toContain('super-secret-pepper-value');
    expect(JSON.stringify(out)).not.toContain('pass@');
  });

  it('collapses Authorization / signing shared tokens the old pattern leaked (AUTHZ/BEARER/HMAC/SIGN)', () => {
    const cfg = {
      AUDIT_ANCHOR_AUTHZ: 'Bearer anchor-shared-token',
      SIEM_AUTHZ: 'Splunk splunk-hec-token',
      WORM_SIGNING_KEY: 'hmac-signing-material',
      EXTERNAL_AUTHZ_TIMEOUT_MS: 3000, // numeric knob that merely MATCHES the pattern
    } as unknown as Config;
    const out = redactConfig(cfg);
    expect(out['AUDIT_ANCHOR_AUTHZ']).toBe('<set>');
    expect(out['SIEM_AUTHZ']).toBe('<set>');
    expect(out['WORM_SIGNING_KEY']).toBe('<set>');
    // A number can't carry a secret — shown as-is, not mislabeled '<unset>'.
    expect(out['EXTERNAL_AUTHZ_TIMEOUT_MS']).toBe(3000);
    const s = JSON.stringify(out);
    expect(s).not.toContain('anchor-shared-token');
    expect(s).not.toContain('splunk-hec-token');
    expect(s).not.toContain('hmac-signing-material');
  });
});

let app: FastifyInstance;
let gadm: string;

beforeEach(() => {
  gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  const config = loadConfig({
    LOG_LEVEL: 'silent',
    GULLEY_ADMIN_SESSION_SECRET: 'z'.repeat(40),
  } as NodeJS.ProcessEnv);
  const ctx = createInMemoryControlContext({
    pepper: 'debug-routes-pepper-16chars!!!!',
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: ['debug-routes-session-secret-32bytes-long'],
    maxSessionTtlMs: 900_000,
  });
  app = buildServer(config, ctx);
});

afterEach(async () => {
  await app.close();
});

const auth = () => ({ authorization: `Bearer ${gadm}`, 'content-type': 'application/json' });

describe('Admin DX routes', () => {
  it('gets and sets the runtime log level, rejecting an invalid one', async () => {
    const set = await app.inject({
      method: 'POST',
      url: '/admin/log-level',
      headers: auth(),
      payload: JSON.stringify({ level: 'debug' }),
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ level: 'debug' });
    expect(app.log.level).toBe('debug');

    const get = await app.inject({ method: 'GET', url: '/admin/log-level', headers: auth() });
    expect(get.json()).toMatchObject({ level: 'debug' });

    const bad = await app.inject({
      method: 'POST',
      url: '/admin/log-level',
      headers: auth(),
      payload: JSON.stringify({ level: 'loud' }),
    });
    expect(bad.statusCode).toBe(422);
  });

  it('serves a redacted config dump and rejects the unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/config-dump', headers: auth() });
    expect(res.statusCode).toBe(200);
    const dump = res.json() as { config: Record<string, unknown> };
    expect(dump.config['GULLEY_ADMIN_SESSION_SECRET']).toBe('<set>');
    expect(JSON.stringify(dump.config)).not.toContain('zzzz'); // secret value never leaks

    const anon = await app.inject({ method: 'GET', url: '/admin/config-dump' });
    expect(anon.statusCode).toBe(401);
  });
});
