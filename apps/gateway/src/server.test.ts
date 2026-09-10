import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { buildServer, parseTrustProxy } from './server';

describe('gateway server', () => {
  it('responds ok on /health', async () => {
    const app = buildServer(
      loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv),
    );
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'gateway' });
    await app.close();
  });

  it('flips /ready to 503 (draining) once a drain begins, for pre-close endpoint deregistration', async () => {
    const draining = { active: false };
    const app = buildServer(
      loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv),
      undefined,
      { isDraining: () => draining.active },
    );
    // Health-only (no context) is already 503 'degraded'; assert the DRAINING status
    // specifically once the flag is set — that is what the preStop path relies on.
    draining.active = true;
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'draining' });
    await app.close();
  });

  it('applies the configured body limit (a large body is not 413ed by the 1 MiB default)', async () => {
    const app = buildServer(
      loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        MAX_REQUEST_BYTES: String(8 * 1024 * 1024),
      } as NodeJS.ProcessEnv),
    );
    // No route table is wired (health-only), so a POST to /v1/messages 404s — but
    // the point is that a >1 MiB body is NOT rejected at the body-limit layer (413)
    // before routing. A 413 would prove the default cap was still in force.
    const big = JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024) });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      payload: big,
    });
    expect(res.statusCode).not.toBe(413);
    await app.close();
  });
});

describe('parseTrustProxy', () => {
  it('parses booleans, hop counts, and CIDR lists', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('10.0.0.0/8,127.0.0.1')).toBe('10.0.0.0/8,127.0.0.1');
  });
});
