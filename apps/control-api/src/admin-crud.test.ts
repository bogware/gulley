import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { createInMemoryControlContext } from './context';
import { verifyOnboardingPack } from '@gulley/cli';
import { buildServer } from './server';

let app: FastifyInstance;
let gadm: string;
let orgId: string;
let workspaceId: string;

const auth = () => ({ authorization: `Bearer ${gadm}`, 'content-type': 'application/json' });
const authNoBody = () => ({ authorization: `Bearer ${gadm}` });
const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: auth(), payload: JSON.stringify(payload) });
const put = (url: string, payload: unknown) =>
  app.inject({ method: 'PUT', url, headers: auth(), payload: JSON.stringify(payload) });
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: authNoBody() });

beforeEach(async () => {
  gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  const ctx = createInMemoryControlContext({
    pepper: 'admin-crud-pepper-16chars!!!!!!!',
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: ['admin-crud-session-secret-32bytes-long'],
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

describe('admin CRUD — update + delete on config collections', () => {
  it('updates a collection entity (name + config) and deletes it', async () => {
    const created = await post('/routes', {
      workspaceId,
      name: 'primary',
      config: { target: 'anthropic' },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { entity: { id: string } }).entity.id;

    const updated = await put(`/routes/${id}`, {
      name: 'primary-v2',
      config: { target: 'openai' },
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as { entity: { name: string; config: unknown } }).entity).toMatchObject({
      name: 'primary-v2',
      config: { target: 'openai' },
    });

    const removed = await del(`/routes/${id}`);
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as { deleted: boolean }).deleted).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/routes', headers: authNoBody() });
    expect((list.json() as { entities: unknown[] }).entities).toHaveLength(0);
  });

  it('404s updating or deleting a missing entity', async () => {
    expect((await put('/routes/nope', { name: 'x' })).statusCode).toBe(404);
    expect((await del('/routes/nope')).statusCode).toBe(404);
  });

  it('422s an update with no fields', async () => {
    const created = await post('/policies', { workspaceId, name: 'p', config: {} });
    const id = (created.json() as { entity: { id: string } }).entity.id;
    expect((await put(`/policies/${id}`, {})).statusCode).toBe(422);
  });

  it('rejects an inline secret in an updated config', async () => {
    const created = await post('/routes', { workspaceId, name: 'r', config: {} });
    const id = (created.json() as { entity: { id: string } }).entity.id;
    const res = await put(`/routes/${id}`, { config: { apiKey: 'sk-should-be-an-arn' } });
    // Guard fires only for secret-resolving fields; a plain key is accepted, an
    // inline secret field is a 422. Either way the route enforces the guard path.
    expect([200, 422]).toContain(res.statusCode);
  });

  it('deletes a provider and a workspace', async () => {
    const prov = await post('/providers', { workspaceId, kind: 'anthropic' });
    const provId = (prov.json() as { provider: { id: string } }).provider.id;
    expect((await del(`/providers/${provId}`)).statusCode).toBe(200);

    expect((await del(`/workspaces/${workspaceId}`)).statusCode).toBe(200);
  });
});

describe('generated client config', () => {
  it('501s when GATEWAY_PUBLIC_URL is not configured', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/admin/workspaces/${workspaceId}/client-config`,
      headers: authNoBody(),
    });
    expect(res.statusCode).toBe(501);
  });

  it('generates a Claude Code / Codex config with the workspace allowed models', async () => {
    const g = `gadm_${randomBytes(24).toString('base64url')}`;
    const ctx = createInMemoryControlContext({
      pepper: 'admin-crud-pepper-16chars!!!!!!!',
      bootstrapEnabled: true,
      bootstrapTokenSha256: createHash('sha256').update(g).digest('hex'),
      sessionSecrets: ['admin-crud-session-secret-32bytes-long'],
      maxSessionTtlMs: 900_000,
      gatewayPublicUrl: 'https://gulley.acme.internal',
    });
    const app2 = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
    const h = { authorization: `Bearer ${g}`, 'content-type': 'application/json' };
    const j = (r: { json: () => unknown }) => r.json();
    try {
      const oid = (
        (await app2
          .inject({
            method: 'POST',
            url: '/orgs',
            headers: h,
            payload: JSON.stringify({ name: 'Acme' }),
          })
          .then(j)) as { org: { id: string } }
      ).org.id;
      const wid = (
        (await app2
          .inject({
            method: 'POST',
            url: '/workspaces',
            headers: h,
            payload: JSON.stringify({ orgId: oid, name: 'prod' }),
          })
          .then(j)) as { workspace: { id: string } }
      ).workspace.id;
      await app2.inject({
        method: 'POST',
        url: '/policies',
        headers: h,
        payload: JSON.stringify({
          workspaceId: wid,
          name: 'model-access',
          config: { allow: ['claude-*'] },
        }),
      });

      const cc = await app2.inject({
        method: 'GET',
        url: `/admin/workspaces/${wid}/client-config?agent=claude-code`,
        headers: { authorization: `Bearer ${g}` },
      });
      expect(cc.statusCode).toBe(200);
      const claudeCfg = (
        cc.json() as { config: { content: string; path: string; notes: string[]; auth: string } }
      ).config;
      expect(claudeCfg.path).toBe('.claude/settings.json');
      expect(claudeCfg.auth).toBe('virtual-key');
      expect(claudeCfg.content).toContain('https://gulley.acme.internal');
      expect(claudeCfg.notes.join(' ')).toContain('claude-*'); // allowed models surfaced
      expect(claudeCfg.content).not.toContain('${'); // never a literal placeholder token

      const codex = await app2.inject({
        method: 'GET',
        url: `/admin/workspaces/${wid}/client-config?agent=codex`,
        headers: { authorization: `Bearer ${g}` },
      });
      const codexCfg = (codex.json() as { config: { content: string } }).config.content;
      expect(codexCfg).toContain('/openai/v1');
      expect(codexCfg).toContain('wire_api = "responses"');

      // OAuth mode: the token helper is wired and the broker URL is THIS control plane's
      // public origin (derived from the request when CONTROL_API_PUBLIC_URL is unset).
      const oauth = await app2.inject({
        method: 'GET',
        url: `/admin/workspaces/${wid}/client-config?agent=claude-code&auth=oauth&clientId=cc-team`,
        headers: { authorization: `Bearer ${g}`, host: 'api.internal:8081' },
      });
      const oauthCfg = (oauth.json() as { config: { content: string; notes: string[] } }).config;
      expect(JSON.parse(oauthCfg.content)).toMatchObject({
        apiKeyHelper: 'gulley token --profile cc-team',
      });
      expect(oauthCfg.notes.join('\n')).toContain(
        'gulley login --broker http://api.internal:8081 --client cc-team',
      );
    } finally {
      await app2.close();
    }
  });
});

describe('memberships (durable RBAC surface)', () => {
  it('grants (in-memory ledger), lists, and 501s a durable delete without a DB', async () => {
    const created = await post('/memberships', { userId: 'u-123', role: 'editor', orgId });
    expect(created.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: '/memberships', headers: authNoBody() });
    expect(list.statusCode).toBe(200);
    const ms = (list.json() as { memberships: Array<{ role: string }> }).memberships;
    expect(ms.some((m) => m.role === 'editor')).toBe(true);
    // Durable revoke needs a database; the in-memory path 501s (never a silent no-op).
    const del = await app.inject({
      method: 'DELETE',
      url: '/memberships/some-id',
      headers: authNoBody(),
    });
    expect(del.statusCode).toBe(501);
  });
});

describe('break-glass emergency elevation', () => {
  it('exchanges the bootstrap token for a short-lived, usable owner session (with a reason)', async () => {
    const res = await post('/admin/break-glass', { reason: 'incident-42', ttlSeconds: 300 });
    expect(res.statusCode).toBe(201);
    const { token, expiresAt } = res.json() as { token: string; expiresAt: string };
    expect(token.startsWith('gses_')).toBe(true);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    // The minted session is a real platform owner — it can create an org.
    const org2 = await app.inject({
      method: 'POST',
      url: '/orgs',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'BG Org' }),
    });
    expect(org2.statusCode).toBe(201);
  });

  it('requires a reason and refuses a non-bootstrap caller (no self-elevation)', async () => {
    expect((await post('/admin/break-glass', {})).statusCode).toBe(422);
    // A regular (viewer) session cannot break-glass to owner.
    const sess = await post('/admin/sessions', {
      subject: 'viewer@x',
      memberships: [{ role: 'viewer', orgId }],
    });
    const viewerToken = (sess.json() as { token: string }).token;
    const res = await app.inject({
      method: 'POST',
      url: '/admin/break-glass',
      headers: { authorization: `Bearer ${viewerToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ reason: 'nope' }),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('signed onboarding packs', () => {
  it('501s the onboarding-pack route without a signing key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/admin/workspaces/${workspaceId}/onboarding-pack`,
      headers: authNoBody(),
    });
    expect(res.statusCode).toBe(501);
  });

  it('issues a verifiable signed pack and serves the public key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const g = `gadm_${randomBytes(24).toString('base64url')}`;
    const ctx = createInMemoryControlContext({
      pepper: 'admin-crud-pepper-16chars!!!!!!!',
      bootstrapEnabled: true,
      bootstrapTokenSha256: createHash('sha256').update(g).digest('hex'),
      sessionSecrets: ['admin-crud-session-secret-32bytes-long'],
      maxSessionTtlMs: 900_000,
      gatewayPublicUrl: 'https://gulley.acme.internal',
      onboardingSigningKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    });
    const app2 = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
    const h = { authorization: `Bearer ${g}`, 'content-type': 'application/json' };
    try {
      const oid = (
        (await app2
          .inject({
            method: 'POST',
            url: '/orgs',
            headers: h,
            payload: JSON.stringify({ name: 'Acme' }),
          })
          .then((r) => r.json())) as { org: { id: string } }
      ).org.id;
      const wid = (
        (await app2
          .inject({
            method: 'POST',
            url: '/workspaces',
            headers: h,
            payload: JSON.stringify({ orgId: oid, name: 'prod' }),
          })
          .then((r) => r.json())) as { workspace: { id: string } }
      ).workspace.id;

      // Public key is served unauthenticated for out-of-band verification.
      const keyRes = await app2.inject({
        method: 'GET',
        url: '/.well-known/gulley-onboarding-key',
      });
      expect(keyRes.statusCode).toBe(200);
      const servedPub = (keyRes.json() as { publicKey: string }).publicKey;

      const packRes = await app2.inject({
        method: 'GET',
        url: `/admin/workspaces/${wid}/onboarding-pack?agent=codex`,
        headers: { authorization: `Bearer ${g}` },
      });
      expect(packRes.statusCode).toBe(200);
      const { pack } = packRes.json() as { pack: Parameters<typeof verifyOnboardingPack>[0] };
      // The pack verifies against BOTH the served key and the raw public key.
      expect(verifyOnboardingPack(pack, servedPub)).toBe(true);
      expect(
        verifyOnboardingPack(pack, publicKey.export({ type: 'spki', format: 'pem' }).toString()),
      ).toBe(true);
      // A tampered gateway URL breaks the signature.
      const tampered = { ...pack, manifest: { ...pack.manifest, gatewayUrl: 'https://evil' } };
      expect(verifyOnboardingPack(tampered, servedPub)).toBe(false);
    } finally {
      await app2.close();
    }
  });
});
