import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { createInMemoryControlContext } from './context';
import { buildServer } from './server';

let app: FastifyInstance;
let gadm: string;
let orgId: string;
let workspaceId: string;

const post = (url: string, payload: unknown) =>
  app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${gadm}`, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
const put = (url: string, payload: unknown) =>
  app.inject({
    method: 'PUT',
    url,
    headers: { authorization: `Bearer ${gadm}`, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${gadm}` } });

beforeEach(async () => {
  gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  const ctx = createInMemoryControlContext({
    pepper: 'parity-routes-pepper-16chars!!!!',
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: ['parity-routes-session-secret-32byteslong'],
    maxSessionTtlMs: 900_000,
  });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
  orgId = ((await post('/orgs', { name: 'Acme' }).then((r) => r.json())) as { org: { id: string } })
    .org.id;
  workspaceId = (
    (await post('/workspaces', { orgId, name: 'prod' }).then((r) => r.json())) as {
      workspace: { id: string };
    }
  ).workspace.id;
});

afterEach(async () => {
  await app.close();
});

describe('parity routes', () => {
  it('GET /admin/status reports subsystem flags + version', async () => {
    const r = await get('/admin/status');
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      version: string;
      durable: boolean;
      subsystems: Record<string, boolean>;
    };
    expect(typeof body.version).toBe('string');
    expect(body.durable).toBe(false); // in-memory context
    expect(body.subsystems.worm).toBe(false);
    expect(body.subsystems).toHaveProperty('cryptoShred');
    expect(body.subsystems).toHaveProperty('gatewayMetrics');
  });

  it('GET /audit/events lists the hash-chained rows newest-first, paginated', async () => {
    // Creating the org + workspace above already appended audit rows.
    const r = await get('/audit/events?limit=1');
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      events: Array<{ seq: number; action: string }>;
      nextCursor?: number;
    };
    expect(body.events.length).toBe(1);
    // Newest first: a later seq than the next page's.
    const first = body.events[0]!.seq;
    if (body.nextCursor !== undefined) {
      const r2 = await get(`/audit/events?limit=1&before=${body.nextCursor}`);
      const body2 = r2.json() as { events: Array<{ seq: number }> };
      expect(body2.events[0]!.seq).toBeLessThan(first);
    }
  });

  it('PUT /providers/:id toggles enabled + re-points baseUrl; GET credential reports unset', async () => {
    const prov = (
      (await post('/providers', { workspaceId, kind: 'anthropic' }).then((r) => r.json())) as {
        provider: { id: string; enabled: boolean };
      }
    ).provider;
    const cred = await get(`/providers/${prov.id}/credential`);
    expect((cred.json() as { configured: boolean }).configured).toBe(false);

    const upd = await put(`/providers/${prov.id}`, { enabled: false });
    expect(upd.statusCode).toBe(200);
    expect((upd.json() as { provider: { enabled: boolean } }).provider.enabled).toBe(false);

    // A non-https baseUrl is rejected by the egress guard (422).
    const bad = await put(`/providers/${prov.id}`, { baseUrl: 'http://models.internal/v1' });
    expect(bad.statusCode).toBe(422);
  });

  it('GET /admin/users returns durable:false + empty in the in-memory context', async () => {
    const r = await get('/admin/users');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ durable: false, users: [] });
  });

  it('GET /admin/observability/status reports not-configured when no metrics URL', async () => {
    const r = await get('/admin/observability/status');
    expect(r.statusCode).toBe(200);
    expect((r.json() as { configured: boolean }).configured).toBe(false);
  });
});
