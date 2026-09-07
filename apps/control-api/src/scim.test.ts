import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { type AdminSessionClaims, signAdminSession } from '@gulley/auth';
import { type Database, schema } from '@gulley/storage';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { createInMemoryControlContext } from './context';
import { buildServer } from './server';

const SECRET = 'scim-session-secret-at-least-32-chars!!';
let client: PGlite;
let app: FastifyInstance;
let gadm: string;

async function applyMigrations(pg: PGlite): Promise<void> {
  const dir = fileURLToPath(new URL('../../../packages/storage/migrations', import.meta.url));
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    for (let stmt of readFileSync(`${dir}/${f}`, 'utf8').split('--> statement-breakpoint')) {
      stmt = stmt.trim();
      if (!stmt) continue;
      if (/create extension.*vector/i.test(stmt)) continue;
      if (/using hnsw/i.test(stmt)) continue;
      if (/::vector/i.test(stmt)) continue;
      stmt = stmt.replace(/vector\(\d+\)/gi, 'text');
      await pg.exec(stmt);
    }
  }
}

const jsonHeaders = (bearer: string) => ({
  authorization: `Bearer ${bearer}`,
  'content-type': 'application/json',
});

function devSession(subject: string): string {
  const iat = Math.floor(Date.now() / 1000);
  const claims: AdminSessionClaims = {
    sub: subject,
    name: subject,
    jti: randomUUID(),
    memberships: [], // NO token memberships — access must come from the durable store
    iat,
    exp: iat + 600,
    typ: 'admin-session',
    ver: 1,
  };
  return signAdminSession(SECRET, claims);
}

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Database;
  await applyMigrations(client);
  gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  const ctx = createInMemoryControlContext({
    pepper: 'scim-pepper-at-least-16-chars!!!',
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: [SECRET],
    maxSessionTtlMs: 900_000,
    db,
  });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
});

afterAll(async () => {
  await app.close();
  await client.close();
});

describe('SCIM 2.0 Users provisioning', () => {
  it('provisions, looks up, and deprovisions an admin user — deprovision cascades to deauthz', async () => {
    const post = (url: string, payload: unknown, bearer = gadm) =>
      app.inject({
        method: 'POST',
        url,
        headers: jsonHeaders(bearer),
        payload: JSON.stringify(payload),
      });

    // Platform scaffolding (bootstrap owner).
    const orgId = (
      (await post('/orgs', { name: 'Acme' }).then((r) => r.json())) as { org: { id: string } }
    ).org.id;
    const wsId = (
      (await post('/workspaces', { orgId, name: 'prod' }).then((r) => r.json())) as {
        workspace: { id: string };
      }
    ).workspace.id;

    // 1) IdP provisions a user via SCIM.
    const created = await post('/scim/v2/Users', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'dev@corp',
      displayName: 'Dev',
      emails: [{ value: 'dev@corp.com', primary: true }],
    });
    expect(created.statusCode).toBe(201);
    const user = created.json() as { id: string; userName: string; active: boolean };
    expect(user.userName).toBe('dev@corp');
    expect(user.active).toBe(true);

    // 2) SCIM lookup-by-filter (the IdP's pre-create existence check).
    const found = await app.inject({
      method: 'GET',
      url: '/scim/v2/Users?filter=' + encodeURIComponent('userName eq "dev@corp"'),
      headers: { authorization: `Bearer ${gadm}` },
    });
    expect((found.json() as { totalResults: number }).totalResults).toBe(1);

    // 3) An admin grants the provisioned user an editor role (durable RBAC).
    await post('/memberships', { subject: 'dev@corp', role: 'editor', orgId });

    // 4) The user's session (NO token memberships) can now do editor work — the
    //    grant is loaded from the durable store at auth time.
    const session = devSession('dev@corp');
    const before = await post(
      '/routes',
      { workspaceId: wsId, name: 'r1', config: { target: 'anthropic' } },
      session,
    );
    expect(before.statusCode).toBe(201);

    // 5) IdP deprovisions (SCIM DELETE) — cascades to the membership grant.
    const del = await app.inject({
      method: 'DELETE',
      url: `/scim/v2/Users/${user.id}`,
      headers: { authorization: `Bearer ${gadm}` },
    });
    expect(del.statusCode).toBe(204);

    // 6) The SAME session immediately loses access — the grant was cascaded away, so
    //    the membership loader now returns nothing for this subject.
    const after = await post(
      '/routes',
      { workspaceId: wsId, name: 'r2', config: { target: 'anthropic' } },
      session,
    );
    expect(after.statusCode).toBe(403);
  });

  it('deactivation via PATCH active=false also deprovisions', async () => {
    const post = (url: string, payload: unknown) =>
      app.inject({
        method: 'POST',
        url,
        headers: jsonHeaders(gadm),
        payload: JSON.stringify(payload),
      });
    const created = await post('/scim/v2/Users', { userName: 'temp@corp', displayName: 'Temp' });
    const id = (created.json() as { id: string }).id;
    const patched = await app.inject({
      method: 'PATCH',
      url: `/scim/v2/Users/${id}`,
      headers: jsonHeaders(gadm),
      payload: JSON.stringify({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      }),
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { active: boolean }).active).toBe(false);
    // Gone from the directory.
    const get = await app.inject({
      method: 'GET',
      url: `/scim/v2/Users/${id}`,
      headers: { authorization: `Bearer ${gadm}` },
    });
    expect(get.statusCode).toBe(404);
  });

  it('refuses provisioning without platform-owner authz', async () => {
    // A viewer session (no owner grant) cannot provision.
    const viewer = devSession('viewer@corp');
    const res = await app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers: jsonHeaders(viewer),
      payload: JSON.stringify({ userName: 'x@corp' }),
    });
    expect(res.statusCode).toBe(403);
  });
});
