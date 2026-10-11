import { createHash, randomBytes } from 'node:crypto';
import { AlertDispatcher, type AlertEvent, type AlertSink } from '@gulley/alerts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { type ControlContext, createInMemoryControlContext } from './context';
import { buildServer } from './server';

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

const SLACK_URL = 'https://hooks.slack.test/services/T/B/x';

/** fetch stub: 200 for the Slack hook, 404 for the webhook — one success, one failure. */
function fakeFetch(calls: string[]): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    const status = u.startsWith(SLACK_URL) ? 200 : 404;
    return { ok: status === 200, status } as unknown as Response;
  }) as unknown as typeof fetch;
}

function build(alerts?: AlertSink): { app: FastifyInstance; gadm: string; ctx: ControlContext } {
  const gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  const ctx = createInMemoryControlContext({
    pepper: 'alert-routes-pepper-16chars!!!!!!',
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: ['alert-routes-session-secret-32byteslong'],
    maxSessionTtlMs: 900_000,
    ...(alerts ? { alerts } : {}),
  });
  return {
    app: buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx),
    gadm,
    ctx,
  };
}

describe('alert routes', () => {
  it('401s without an admin token', async () => {
    const built = build();
    app = built.app;
    expect((await app.inject({ method: 'POST', url: '/admin/alerts/test' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/admin/alerts/status' })).statusCode).toBe(401);
  });

  it('reports disabled / 501s when no channels are configured', async () => {
    const built = build();
    app = built.app;
    const h = { authorization: `Bearer ${built.gadm}` };
    const status = await app.inject({ method: 'GET', url: '/admin/alerts/status', headers: h });
    expect(status.json()).toEqual({ enabled: false, channels: [] });
    const test = await app.inject({ method: 'POST', url: '/admin/alerts/test', headers: h });
    expect(test.statusCode).toBe(501);
  });

  it('delivers a synthetic event to every channel, reports per channel and audits it', async () => {
    const calls: string[] = [];
    const dispatcher = new AlertDispatcher({
      channels: [
        { type: 'slack', url: SLACK_URL, events: ['budget.*'] },
        { type: 'webhook', url: 'https://hooks.test/gulley', secret: 'a-shared-secret-16+chars' },
      ],
      egress: { allowlist: ['hooks.slack.test', 'hooks.test'] },
      fetchImpl: fakeFetch(calls),
      retryDelaysMs: [],
    });
    const built = build(dispatcher);
    app = built.app;
    const h = { authorization: `Bearer ${built.gadm}` };

    const res = await app.inject({ method: 'POST', url: '/admin/alerts/test', headers: h });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      event: { kind: string; severity: string };
      channels: Array<{ channel: string; ok: boolean; filtered: boolean; error?: string }>;
    };
    expect(body.event).toMatchObject({ kind: 'config.applied', severity: 'info' });
    expect(body.channels).toEqual([
      { channel: 'slack', type: 'slack', ok: true, attempts: 1, filtered: true },
      {
        channel: 'webhook',
        type: 'webhook',
        ok: false,
        attempts: 1,
        filtered: false,
        error: expect.stringMatching(/HTTP 404/),
      },
    ]);
    expect(calls).toHaveLength(2);
    // No URL leaks into the response.
    expect(res.body).not.toContain('hooks.slack.test');
    expect(res.body).not.toContain('hooks.test/gulley');

    const audited = await built.ctx.auditByAction('alerts.test', 10);
    expect(audited).toHaveLength(1);
    expect(audited[0]?.payload).toEqual({
      channels: [
        { channel: 'slack', type: 'slack', ok: true, attempts: 1 },
        { channel: 'webhook', type: 'webhook', ok: false, attempts: 1 },
      ],
    });

    const status = await app.inject({ method: 'GET', url: '/admin/alerts/status', headers: h });
    const s = status.json() as { enabled: boolean; channels: Array<{ name: string }> };
    expect(s.enabled).toBe(true);
    expect(s.channels.map((c) => c.name)).toEqual(['slack', 'webhook']);
    expect(status.body).not.toContain('hooks.slack.test');
  });
});

describe('control-plane event sources', () => {
  it('break-glass emits admin.break_glass after the audit row', async () => {
    const events: AlertEvent[] = [];
    const built = build({ emit: (e) => events.push(e) });
    app = built.app;
    const res = await app.inject({
      method: 'POST',
      url: '/admin/break-glass',
      headers: { authorization: `Bearer ${built.gadm}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ reason: 'prod incident 42' }),
    });
    expect(res.statusCode).toBe(201);
    const { expiresAt } = res.json() as { expiresAt: string };
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'admin.break_glass',
      severity: 'critical',
      reason: 'prod incident 42',
      expiresAt,
    });
    expect((events[0] as { actor: string }).actor).toBeTruthy();
  });

  it('a successful config apply emits config.applied; a rejected one does not', async () => {
    const events: AlertEvent[] = [];
    const built = build({ emit: (e) => events.push(e) });
    app = built.app;
    const h = { authorization: `Bearer ${built.gadm}`, 'content-type': 'application/json' };
    const ok = await app.inject({
      method: 'POST',
      url: '/config/apply',
      headers: h,
      payload: JSON.stringify({ document: { apiVersion: 'gulley/v1', orgs: [] }, baseVersion: 0 }),
    });
    expect(ok.statusCode).toBe(200);
    const { version, contentHash } = ok.json() as { version: number; contentHash: string };
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'config.applied',
      severity: 'info',
      version,
      contentHash,
    });

    const stale = await app.inject({
      method: 'POST',
      url: '/config/apply',
      headers: h,
      payload: JSON.stringify({ document: { apiVersion: 'gulley/v1', orgs: [] }, baseVersion: 99 }),
    });
    expect(stale.statusCode).toBe(409);
    expect(events).toHaveLength(1);
  });
});
