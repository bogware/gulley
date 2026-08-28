import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { createInMemoryControlContext } from './context';
import { buildServer } from './server';

let app: FastifyInstance;
let gadm: string;
let workspaceId: string;

const auth = () => ({ authorization: `Bearer ${gadm}`, 'content-type': 'application/json' });
// GET/DELETE carry no body — a JSON content-type with an empty body is a 400.
const authNoBody = () => ({ authorization: `Bearer ${gadm}` });

async function post(url: string, payload: unknown) {
  return app.inject({ method: 'POST', url, headers: auth(), payload: JSON.stringify(payload) });
}

beforeEach(async () => {
  gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  const ctx = createInMemoryControlContext({
    pepper: 'prompt-routes-pepper-16chars!!!!',
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: ['prompt-routes-session-secret-32bytes-long'],
    maxSessionTtlMs: 900_000,
  });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);

  const org = (await post('/orgs', { name: 'Acme' }).then((r) => r.json())) as {
    org: { id: string };
  };
  const ws = (await post('/workspaces', { orgId: org.org.id, name: 'prod' }).then((r) =>
    r.json(),
  )) as { workspace: { id: string } };
  workspaceId = ws.workspace.id;
});

afterEach(async () => {
  await app.close();
});

describe('governed prompt registry routes', () => {
  it('creates, versions, reads, and verifies the hash chain', async () => {
    const created = await post('/prompts', {
      workspaceId,
      name: 'greeting',
      body: 'Hello {{name}}',
    });
    expect(created.statusCode).toBe(201);
    const { prompt } = created.json() as { prompt: { id: string; versions: unknown[] } };
    expect(prompt.versions).toHaveLength(1);

    const v2 = await post(`/prompts/${prompt.id}/versions`, {
      body: 'Hello {{name}}, welcome to {{team}}',
      message: 'add team',
    });
    expect(v2.statusCode).toBe(201);
    expect((v2.json() as { version: { version: number } }).version.version).toBe(2);

    const verify = await app.inject({
      method: 'GET',
      url: `/prompts/${prompt.id}/verify`,
      headers: authNoBody(),
    });
    expect(verify.json()).toEqual({ verified: true, count: 2 });
  });

  it('rejects a duplicate name in the same workspace with 409', async () => {
    await post('/prompts', { workspaceId, name: 'dup', body: 'a' });
    const again = await post('/prompts', { workspaceId, name: 'dup', body: 'b' });
    expect(again.statusCode).toBe(409);
  });

  it('renders the head version and 422s on a missing variable', async () => {
    const created = await post('/prompts', {
      workspaceId,
      name: 'r',
      body: 'Hi {{name}} from {{team}}',
    });
    const id = (created.json() as { prompt: { id: string } }).prompt.id;

    const ok = await post(`/prompts/${id}/render`, { variables: { name: 'Ada', team: 'infra' } });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { rendered: string }).rendered).toBe('Hi Ada from infra');

    const bad = await post(`/prompts/${id}/render`, { variables: { name: 'Ada' } });
    expect(bad.statusCode).toBe(422);
    expect((bad.json() as { error: { missing: string[] } }).error.missing).toEqual(['team']);
  });

  it('lists workspace-scoped summaries and deletes', async () => {
    const created = await post('/prompts', { workspaceId, name: 'x', body: 'x' });
    const id = (created.json() as { prompt: { id: string } }).prompt.id;

    const list = await app.inject({ method: 'GET', url: '/prompts', headers: authNoBody() });
    expect((list.json() as { prompts: unknown[] }).prompts).toHaveLength(1);

    const del = await app.inject({
      method: 'DELETE',
      url: `/prompts/${id}`,
      headers: authNoBody(),
    });
    expect(del.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/prompts', headers: authNoBody() });
    expect((after.json() as { prompts: unknown[] }).prompts).toHaveLength(0);
  });

  it('401s without an admin token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/prompts',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ workspaceId, name: 'nope', body: 'x' }),
    });
    expect(res.statusCode).toBe(401);
  });
});
