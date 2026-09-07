import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { createInMemoryControlContext } from './context';
import { buildServer } from './server';
import type { SiemConnector, SiemEvent } from './siem';

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

function build(withSiem: boolean): { app: FastifyInstance; gadm: string; sent: SiemEvent[][] } {
  const gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  const sent: SiemEvent[][] = [];
  const connector: SiemConnector = {
    kind: 'fake',
    send: async (events) => {
      sent.push(events);
    },
  };
  const ctx = createInMemoryControlContext({
    pepper: 'siem-routes-pepper-16chars!!!!!!',
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: ['siem-routes-session-secret-32byteslong'],
    maxSessionTtlMs: 900_000,
    ...(withSiem ? { siem: { connector } } : {}),
  });
  return {
    app: buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx),
    gadm,
    sent,
  };
}

describe('SIEM routes', () => {
  it('501s on status / export when SIEM is off', async () => {
    const built = build(false);
    app = built.app;
    const h = { authorization: `Bearer ${built.gadm}` };
    expect(
      (await app.inject({ method: 'GET', url: '/audit/siem/status', headers: h })).statusCode,
    ).toBe(501);
    expect(
      (await app.inject({ method: 'POST', url: '/audit/siem/export', headers: h })).statusCode,
    ).toBe(501);
  });

  it('401s without an admin token', async () => {
    const built = build(true);
    app = built.app;
    expect((await app.inject({ method: 'GET', url: '/audit/siem/status' })).statusCode).toBe(401);
  });

  it('exports audit events to the connector and is idempotent', async () => {
    const built = build(true);
    app = built.app;
    const h = { authorization: `Bearer ${built.gadm}` };

    await app.inject({
      method: 'POST',
      url: '/orgs',
      headers: { ...h, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Acme' }),
    });

    const status0 = await app.inject({ method: 'GET', url: '/audit/siem/status', headers: h });
    expect(status0.json()).toMatchObject({ enabled: true, kind: 'fake', lastSeq: 0 });

    const exported = await app.inject({ method: 'POST', url: '/audit/siem/export', headers: h });
    const r = exported.json() as { exported: number; lastSeq: number };
    expect(r.exported).toBeGreaterThan(0);
    expect(built.sent[0]?.[0]?.action).toBeTruthy();
    // Provenance rides along.
    expect(built.sent[0]?.[0]?.rowHash).toBeTruthy();

    // Idempotent re-export: nothing new.
    const again = await app.inject({ method: 'POST', url: '/audit/siem/export', headers: h });
    expect(again.json()).toMatchObject({ exported: 0, lastSeq: r.lastSeq });
  });
});
