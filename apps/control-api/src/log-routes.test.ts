import { InMemoryRequestLog, type RequestLogEntry } from '@gulley/pipeline';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config';
import { createInMemoryControlContext } from './context';
import { buildServer } from './server';

const PEPPER = 'log-check-pepper-at-least-16-chars';
const SESSION_SECRET = 'log-check-session-secret-32-chars-min!!';

let app: FastifyInstance;
let log: InMemoryRequestLog;
let gadm: string;

function call(method: 'GET' | 'POST', url: string, token: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

function logEntry(over: Partial<RequestLogEntry>): RequestLogEntry {
  return {
    requestId: 'req',
    principalId: 'vk_1',
    workspaceId: 'ws',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    route: '/v1/messages',
    statusCode: 200,
    status: 'ok',
    streamed: true,
    inputTokens: 100,
    outputTokens: 20,
    costMicroUsd: 500,
    latencyMs: 200,
    createdAt: new Date(Date.UTC(2026, 7, 25, 10, 0)),
    ...over,
  };
}

beforeEach(async () => {
  gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  log = new InMemoryRequestLog();
  const ctx = createInMemoryControlContext({
    pepper: PEPPER,
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: [SESSION_SECRET],
    maxSessionTtlMs: 900_000,
    requestLogQuery: log,
  });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
});

afterEach(async () => {
  await app.close();
});

describe('admin log browser + usage analytics', () => {
  it('browses and rolls up logs, scoped to visible workspaces', async () => {
    const org = await call('POST', '/orgs', gadm, { name: 'Acme' });
    const orgId = (org.json().org as { id: string }).id;
    const ws = await call('POST', '/workspaces', gadm, { orgId, name: 'Default' });
    const wsId = (ws.json().workspace as { id: string }).id;

    for (let i = 0; i < 3; i++) {
      await log.write(
        logEntry({
          requestId: `req_${i}`,
          workspaceId: wsId,
          provider: i === 2 ? 'openai' : 'anthropic',
          createdAt: new Date(Date.UTC(2026, 7, 25, 10, i)),
        }),
      );
    }

    const logs = await call('GET', '/admin/logs', gadm);
    expect(logs.statusCode).toBe(200);
    expect((logs.json().entries as unknown[]).length).toBe(3);

    const one = await call('GET', '/admin/logs/req_1', gadm);
    expect(one.statusCode).toBe(200);
    expect((one.json().entry as { requestId: string }).requestId).toBe('req_1');

    const usage = await call(
      'GET',
      '/admin/analytics/usage?bucket=hour&groupBy=provider&from=2026-08-25T00:00:00Z&to=2026-08-26T00:00:00Z',
      gadm,
    );
    const buckets = usage.json().buckets as Array<{ group: string; requests: number }>;
    expect(buckets.find((b) => b.group === 'anthropic')?.requests).toBe(2);
    expect(buckets.find((b) => b.group === 'openai')?.requests).toBe(1);
  });

  it('501s the shadow-spend route when no reconciliation backend is wired', async () => {
    // The default ctx has no db and no injected shadowSpend port.
    const res = await call('GET', '/admin/analytics/shadow-spend', gadm);
    expect(res.statusCode).toBe(501);
  });

  it('returns the shadow-spend report, RBAC-scoped to visible workspaces', async () => {
    const gadm2 = `gadm_${randomBytes(24).toString('base64url')}`;
    let capturedScope: string[] | undefined;
    const ctx = createInMemoryControlContext({
      pepper: PEPPER,
      bootstrapEnabled: true,
      bootstrapTokenSha256: createHash('sha256').update(gadm2).digest('hex'),
      sessionSecrets: [SESSION_SECRET],
      maxSessionTtlMs: 900_000,
      // Inject the port directly (no live provider calls).
      shadowSpend: (o) => {
        capturedScope = o.workspaceIds;
        return Promise.resolve({
          rows: [
            {
              provider: 'anthropic',
              gatewayMicroUsd: 600_000,
              providerMicroUsd: 1_000_000,
              shadowMicroUsd: 400_000,
              shadowRatio: 0.4,
              flagged: true,
            },
          ],
          gatewayTotalMicroUsd: 600_000,
          providerTotalMicroUsd: 1_000_000,
          shadowTotalMicroUsd: 400_000,
          flagged: true,
          reconciledProviders: ['anthropic'],
        });
      },
    });
    const app2 = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
    try {
      const inject = (url: string) =>
        app2.inject({ method: 'GET', url, headers: { authorization: `Bearer ${gadm2}` } });
      // Give the admin a visible workspace so readScope resolves to a scope.
      const org = await app2.inject({
        method: 'POST',
        url: '/orgs',
        headers: { authorization: `Bearer ${gadm2}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'Acme' }),
      });
      const orgId = (org.json().org as { id: string }).id;
      const ws = await app2.inject({
        method: 'POST',
        url: '/workspaces',
        headers: { authorization: `Bearer ${gadm2}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ orgId, name: 'Default' }),
      });
      const wsId = (ws.json().workspace as { id: string }).id;

      const res = await inject('/admin/analytics/shadow-spend');
      expect(res.statusCode).toBe(200);
      const body = res.json() as { flagged: boolean; shadowTotalMicroUsd: number };
      expect(body.flagged).toBe(true);
      expect(body.shadowTotalMicroUsd).toBe(400_000);
      expect(capturedScope).toContain(wsId); // the port was RBAC-scoped
    } finally {
      await app2.close();
    }
  });

  it('does not leak logs to an admin who cannot see the workspace', async () => {
    const org1 = await call('POST', '/orgs', gadm, { name: 'Acme' });
    const org1Id = (org1.json().org as { id: string }).id;
    const ws = await call('POST', '/workspaces', gadm, { orgId: org1Id, name: 'Default' });
    const wsId = (ws.json().workspace as { id: string }).id;
    await log.write(logEntry({ requestId: 'secret', workspaceId: wsId }));

    // A second org whose admin has no visibility into org1's workspace.
    const org2 = await call('POST', '/orgs', gadm, { name: 'Other' });
    const org2Id = (org2.json().org as { id: string }).id;
    const sess = await call('POST', '/admin/sessions', gadm, {
      subject: 'viewer@other',
      memberships: [{ role: 'viewer', orgId: org2Id }],
    });
    const viewer = (sess.json() as { token: string }).token;

    const logs = await call('GET', '/admin/logs', viewer);
    expect(logs.statusCode).toBe(200);
    expect((logs.json().entries as unknown[]).length).toBe(0);

    const one = await call('GET', '/admin/logs/secret', viewer);
    expect(one.statusCode).toBe(404); // exists, but not visible
  });
});
