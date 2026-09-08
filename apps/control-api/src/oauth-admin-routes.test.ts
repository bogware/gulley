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
const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${gadm}` } });
const del = (url: string) =>
  app.inject({ method: 'DELETE', url, headers: { authorization: `Bearer ${gadm}` } });

beforeEach(async () => {
  gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  const ctx = createInMemoryControlContext({
    pepper: 'oauth-admin-pepper-16chars!!!!!!',
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: ['oauth-admin-session-secret-32byteslong'],
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

describe('OAuth admin surface', () => {
  it('records a minted session, lists it, and revokes it', async () => {
    const mint = await post('/admin/sessions', {
      memberships: [{ role: 'editor', orgId, workspaceId }],
    });
    expect(mint.statusCode).toBe(201);

    const listed = await get('/admin/sessions');
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as {
      enumerable: boolean;
      sessions: Array<{ jti: string; source: string; revoked: boolean }>;
    };
    expect(body.enumerable).toBe(true);
    const session = body.sessions.find((s) => s.source === 'exchange');
    expect(session).toBeDefined();
    expect(session!.revoked).toBe(false);

    const revoke = await del(`/admin/sessions/${session!.jti}`);
    expect(revoke.statusCode).toBe(200);
    const after = await get('/admin/sessions');
    const still = (
      after.json() as { sessions: Array<{ jti: string; revoked: boolean }> }
    ).sessions.find((s) => s.jti === session!.jti);
    expect(still!.revoked).toBe(true);
  });

  it('501s the durable OAuth views without a database', async () => {
    expect((await get('/admin/oauth/clients')).statusCode).toBe(501);
    expect((await get('/admin/oauth/grants')).statusCode).toBe(501);
    expect((await get('/admin/oauth/device-codes')).statusCode).toBe(501);
  });

  it('the refresh-reuse feed is empty (audit-derived) with no reuse events', async () => {
    const r = await get('/admin/security/refresh-reuse');
    expect(r.statusCode).toBe(200);
    expect((r.json() as { alerts: unknown[] }).alerts).toEqual([]);
  });

  it('does not mount the broker /oauth/* protocol surface when disabled', async () => {
    // OAUTH_BROKER_ENABLED is off in this context, so device_authorization is unrouted.
    const r = await app.inject({
      method: 'POST',
      url: '/oauth/device_authorization',
      payload: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(404);
  });
});
