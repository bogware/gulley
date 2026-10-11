import { signAdminSession, verifyAdminSession } from '@gulley/auth';
import { ALL_PERMISSIONS, BUILTIN_ROLES } from '@gulley/rbac';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { createInMemoryControlContext } from './context';
import { CachedRoleResolver } from './roles';
import { parseRoleMap } from './sso';
import { mapMemberships } from './oidc-gate';
import { buildServer } from './server';

const SESSION_SECRET = 'roles-test-session-secret-32-chars-min!!';
let app: FastifyInstance;
let gadm: string;
let orgId: string;
let workspaceId: string;

const hdr = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});
const post = (url: string, payload: unknown, token = gadm) =>
  app.inject({ method: 'POST', url, headers: hdr(token), payload: JSON.stringify(payload) });
const put = (url: string, payload: unknown, token = gadm) =>
  app.inject({ method: 'PUT', url, headers: hdr(token), payload: JSON.stringify(payload) });
const get = (url: string, token = gadm) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
const del = (url: string, token = gadm) =>
  app.inject({ method: 'DELETE', url, headers: { authorization: `Bearer ${token}` } });

/** A session token carrying exactly these memberships (what SSO / an exchange mints). */
function session(
  memberships: Array<{ role: string; orgId: string; workspaceId?: string | null }>,
): string {
  const iat = Math.floor(Date.now() / 1000);
  return signAdminSession(SESSION_SECRET, {
    sub: `user-${randomBytes(4).toString('hex')}`,
    name: 'test',
    jti: randomBytes(8).toString('hex'),
    memberships,
    iat,
    exp: iat + 600,
    typ: 'admin-session',
    ver: 1,
    src: 'oidc',
  });
}

beforeEach(async () => {
  gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  const ctx = createInMemoryControlContext({
    pepper: 'roles-test-pepper-16chars-min!!!',
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: [SESSION_SECRET],
    maxSessionTtlMs: 900_000,
  });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
  orgId = ((await post('/orgs', { name: 'Acme' })).json() as { org: { id: string } }).org.id;
  workspaceId = (
    (await post('/workspaces', { orgId, name: 'prod' })).json() as {
      workspace: { id: string };
    }
  ).workspace.id;
});

afterEach(async () => {
  await app.close();
});

describe('GET /roles', () => {
  it('lists the five built-ins and the permission catalogue', async () => {
    const r = await get('/roles');
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      roles: Array<{ id: string; builtin: boolean }>;
      permissions: string[];
    };
    expect(body.roles.filter((x) => x.builtin).map((x) => x.id)).toEqual(
      BUILTIN_ROLES.map((x) => x.id),
    );
    expect(body.permissions).toEqual([...ALL_PERMISSIONS]);
    expect(body.permissions).toContain('key:disable');
    expect(body.permissions).toContain('key:rotate');
  });

  it('is readable by any scoped admin with role:read (a viewer), not by an unknown role', async () => {
    expect((await get('/roles', session([{ role: 'viewer', orgId }]))).statusCode).toBe(200);
    expect((await get('/roles', session([{ role: 'ghost-role', orgId }]))).statusCode).toBe(403);
  });
});

describe('roles CRUD', () => {
  it('creates, updates, lists and deletes a custom role (audited)', async () => {
    const created = await post('/roles', {
      id: 'key-operator',
      name: 'Key operator',
      description: 'disable + rotate only',
      permissions: ['key:rotate', 'key:disable', 'key:read', 'key:read'],
    });
    expect(created.statusCode).toBe(201);
    expect((created.json() as { role: unknown }).role).toMatchObject({
      id: 'key-operator',
      name: 'Key operator',
      builtin: false,
      permissions: ['key:disable', 'key:read', 'key:rotate'], // de-duplicated, sorted
    });

    const listed = (await get('/roles')).json() as { roles: Array<{ id: string }> };
    expect(listed.roles.some((r) => r.id === 'key-operator')).toBe(true);

    const updated = await put('/roles/key-operator', {
      permissions: ['key:disable'],
      description: '',
    });
    expect(updated.statusCode).toBe(200);
    expect(
      (updated.json() as { role: { permissions: string[]; description?: string } }).role,
    ).toMatchObject({
      permissions: ['key:disable'],
    });

    expect((await del('/roles/key-operator')).statusCode).toBe(200);
    expect((await del('/roles/key-operator')).statusCode).toBe(404);

    const audit = (await get('/audit/events?limit=50')).json() as {
      events: Array<{ action: string; target: string }>;
    };
    const actions = audit.events.filter((e) => e.target === 'key-operator').map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['role.create', 'role.update', 'role.delete']));
  });

  it('validates the id, the name and the permission names', async () => {
    expect((await post('/roles', { id: 'Bad Id', name: 'x', permissions: [] })).statusCode).toBe(
      422,
    );
    expect((await post('/roles', { id: 'ok-id', permissions: [] })).statusCode).toBe(422);
    const bad = await post('/roles', { id: 'ok-id', name: 'x', permissions: ['org:update'] });
    expect(bad.statusCode).toBe(422);
    expect((bad.json() as { error: { message: string } }).error.message).toMatch(
      /unknown permission/,
    );
    expect(
      (await post('/roles', { id: 'ok-id', name: 'x', permissions: 'key:read' })).statusCode,
    ).toBe(422);
  });

  it('refuses to modify or delete a built-in (409) and a duplicate id (409)', async () => {
    expect((await post('/roles', { id: 'owner', name: 'root', permissions: [] })).statusCode).toBe(
      409,
    );
    expect((await put('/roles/viewer', { name: 'ro' })).statusCode).toBe(409);
    expect((await del('/roles/admin')).statusCode).toBe(409);
    expect((await post('/roles', { id: 'dup', name: 'dup', permissions: [] })).statusCode).toBe(
      201,
    );
    expect((await post('/roles', { id: 'dup', name: 'dup', permissions: [] })).statusCode).toBe(
      409,
    );
  });

  it('needs role:create at the platform scope, and refuses permissions the author lacks', async () => {
    // An org-scoped admin holds role:create, but roles are platform objects.
    const orgAdmin = session([{ role: 'admin', orgId }]);
    expect(
      (await post('/roles', { id: 'r1', name: 'r1', permissions: [] }, orgAdmin)).statusCode,
    ).toBe(403);
    // A platform-wide admin may create roles, but not one carrying an owner-only permission.
    const platformAdmin = session([{ role: 'admin', orgId: '*' }]);
    const beyond = await post(
      '/roles',
      { id: 'r2', name: 'r2', permissions: ['guardrail:reveal'] },
      platformAdmin,
    );
    expect(beyond.statusCode).toBe(403);
    expect((beyond.json() as { error: { message: string } }).error.message).toMatch(
      /guardrail:reveal/,
    );
    expect(
      (await post('/roles', { id: 'r3', name: 'r3', permissions: ['key:disable'] }, platformAdmin))
        .statusCode,
    ).toBe(201);
    // A viewer cannot create roles at all.
    expect(
      (
        await post(
          '/roles',
          { id: 'r4', name: 'r4', permissions: [] },
          session([{ role: 'viewer', orgId: '*' }]),
        )
      ).statusCode,
    ).toBe(403);
  });
});

describe('memberships with a custom role', () => {
  it('grants a custom role, refuses an unknown one, and applies the subset check', async () => {
    await post('/roles', {
      id: 'key-operator',
      name: 'k',
      permissions: ['key:read', 'key:disable'],
    });
    const ok = await post('/memberships', {
      userId: randomBytes(8).toString('hex'),
      role: 'key-operator',
      orgId,
    });
    expect(ok.statusCode).toBe(201);
    expect((ok.json() as { membership: { role: string } }).membership.role).toBe('key-operator');

    const unknown = await post('/memberships', { userId: 'u', role: 'no-such-role', orgId });
    expect(unknown.statusCode).toBe(422);

    // An admin may grant key-operator (subset of admin) but a key-operator cannot grant
    // viewer (viewer reads more than the operator holds) nor escalate to admin.
    const admin = session([{ role: 'admin', orgId }]);
    expect(
      (await post('/memberships', { userId: 'u', role: 'key-operator', orgId }, admin)).statusCode,
    ).toBe(201);
    await post('/roles', {
      id: 'granter',
      name: 'g',
      permissions: ['membership:create', 'key:read'],
    });
    const granter = session([{ role: 'granter', orgId }]);
    expect(
      (await post('/memberships', { userId: 'u', role: 'granter', orgId }, granter)).statusCode,
    ).toBe(201);
    expect(
      (await post('/memberships', { userId: 'u', role: 'viewer', orgId }, granter)).statusCode,
    ).toBe(403);
    expect(
      (await post('/memberships', { userId: 'u', role: 'admin', orgId }, granter)).statusCode,
    ).toBe(403);
  });

  it('delegated sessions apply the same subset rule to custom roles', async () => {
    await post('/roles', {
      id: 'key-operator',
      name: 'k',
      permissions: ['key:read', 'key:disable'],
    });
    const admin = session([{ role: 'admin', orgId }]);
    const ok = await post(
      '/admin/sessions',
      { memberships: [{ role: 'key-operator', orgId }] },
      admin,
    );
    expect(ok.statusCode).toBe(201);
    const esc = await post('/admin/sessions', { memberships: [{ role: 'owner', orgId }] }, admin);
    expect(esc.statusCode).toBe(403);
    const unknown = await post(
      '/admin/sessions',
      { memberships: [{ role: 'ghost', orgId }] },
      admin,
    );
    expect(unknown.statusCode).toBe(422);
  });
});

describe('key permissions (the key:create defect regression)', () => {
  let keyId: string;
  beforeEach(async () => {
    keyId = ((await post('/keys', { workspaceId, name: 'k' })).json() as { id: string }).id;
  });

  it('a custom role with key:disable + key:rotate but not key:create can disable/rotate, not mint', async () => {
    await post('/roles', {
      id: 'key-operator',
      name: 'k',
      permissions: ['key:read', 'key:disable', 'key:rotate'],
    });
    const op = session([{ role: 'key-operator', orgId }]);
    expect((await post(`/keys/${keyId}/disable`, {}, op)).statusCode).toBe(200);
    expect((await post(`/keys/${keyId}/rotate`, {}, op)).statusCode).toBe(200);
    expect((await post('/keys', { workspaceId, name: 'nope' }, op)).statusCode).toBe(403);
  });

  it('a custom role with key:create but neither lifecycle verb can mint, not disable/rotate', async () => {
    await post('/roles', { id: 'key-minter', name: 'm', permissions: ['key:read', 'key:create'] });
    const minter = session([{ role: 'key-minter', orgId }]);
    expect((await post('/keys', { workspaceId, name: 'minted' }, minter)).statusCode).toBe(201);
    expect((await post(`/keys/${keyId}/disable`, {}, minter)).statusCode).toBe(403);
    expect((await post(`/keys/${keyId}/rotate`, {}, minter)).statusCode).toBe(403);
  });

  it('built-in editor keeps mint + disable + rotate; viewer has none', async () => {
    const editor = session([{ role: 'editor', orgId }]);
    expect((await post(`/keys/${keyId}/disable`, {}, editor)).statusCode).toBe(200);
    expect((await post(`/keys/${keyId}/rotate`, {}, editor)).statusCode).toBe(200);
    expect((await post('/keys', { workspaceId, name: 'e' }, editor)).statusCode).toBe(201);
    const viewer = session([{ role: 'viewer', orgId }]);
    expect((await post(`/keys/${keyId}/disable`, {}, viewer)).statusCode).toBe(403);
    expect((await post(`/keys/${keyId}/rotate`, {}, viewer)).statusCode).toBe(403);
  });

  it('a deleted custom role grants nothing (unknown id ⇒ deny, never a 500)', async () => {
    await post('/roles', { id: 'temp', name: 't', permissions: ['key:read', 'key:disable'] });
    const holder = session([{ role: 'temp', orgId }]);
    expect((await post(`/keys/${keyId}/disable`, {}, holder)).statusCode).toBe(200);
    await del('/roles/temp');
    expect((await post(`/keys/${keyId}/disable`, {}, holder)).statusCode).toBe(403);
    expect((await get(`/keys/${keyId}`, holder)).statusCode).toBe(403);
  });
});

describe('session claims and SSO role maps carry custom role ids', () => {
  it('verifyAdminSession keeps a custom role id and drops a malformed one', () => {
    const token = session([
      { role: 'key-operator', orgId: 'o1' },
      { role: 'Bad Role!', orgId: 'o1' },
      { role: 'owner', orgId: 'o1' },
    ]);
    const v = verifyAdminSession([SESSION_SECRET], token, { now: Date.now(), maxTtlMs: 900_000 });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.principal.memberships.map((m) => m.role)).toEqual(['key-operator', 'owner']);
    }
  });

  it('parseRoleMap / mapMemberships accept a custom role id (OIDC and SAML share them)', () => {
    const rules = parseRoleMap(
      '[{"group":"ops","role":"key-operator","orgId":"*"},{"group":"x","role":"Not Valid","orgId":"*"}]',
    );
    expect(rules.map((r) => r.role)).toEqual(['key-operator']);
    expect(mapMemberships(['ops'], rules, ['o1', 'o2'])).toEqual([
      { role: 'key-operator', orgId: 'o1', workspaceId: null },
      { role: 'key-operator', orgId: 'o2', workspaceId: null },
    ]);
  });
});

describe('CachedRoleResolver', () => {
  it('memoizes for the TTL, refreshes after it, and keeps the stale snapshot on error', async () => {
    let t = 1_000_000;
    let loads = 0;
    let fail = false;
    const errors: unknown[] = [];
    const resolver = new CachedRoleResolver(
      async () => {
        loads += 1;
        if (fail) throw new Error('db down');
        return [
          {
            id: `r${loads}`,
            name: 'r',
            description: null,
            permissions: ['key:read', 'not-a-permission'],
            builtin: false,
            orgId: null,
            createdAt: '',
            updatedAt: '',
          },
        ];
      },
      { ttlMs: 10_000, now: () => t, onError: (e) => errors.push(e) },
    );
    expect(resolver.get('owner')?.builtin).toBe(true); // built-ins never need a load
    await resolver.ensureFresh();
    expect(loads).toBe(1);
    expect(resolver.get('r1')?.permissions).toEqual(['key:read']); // unknown name dropped
    await resolver.ensureFresh();
    expect(loads).toBe(1); // within TTL
    t += 10_000;
    await resolver.ensureFresh();
    expect(loads).toBe(2);
    expect(resolver.get('r2')).toBeDefined();
    expect(resolver.get('r1')).toBeUndefined();
    fail = true;
    resolver.invalidate();
    await resolver.ensureFresh();
    expect(loads).toBe(3);
    expect(errors).toHaveLength(1);
    expect(resolver.get('r2')).toBeDefined(); // stale snapshot kept
    await resolver.ensureFresh();
    expect(loads).toBe(3); // not hammered until the TTL passes again
  });
});
