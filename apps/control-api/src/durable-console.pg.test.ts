import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import {
  type ConfigSignal,
  type Database,
  expectedSchemaMillis,
  InMemoryConfigBus,
  PostgresConfigStore,
  schema,
} from '@gulley/storage';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { type ControlContext, createInMemoryControlContext } from './context';
import { buildServer } from './server';

/**
 * DB mode durability (refine cycle 2026-09, F2/F13/F18/S17): console edits commit to the
 * Postgres config tables the gateway reads — with an audit row, a config_version bump and
 * a bus signal — and are visible to a SECOND control-api process over the same database
 * after a hydrate. Prompts are durable too, and /ready gates on the migration state.
 */
const SECRET = 'durable-console-session-secret-32chars!';
let client: PGlite;
let db: Database;
let app: FastifyInstance;
let ctx: ControlContext;
let gadm: string;
let orgId: string;
let workspaceId: string;
let signals: ConfigSignal[];

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

const headers = () => ({ authorization: `Bearer ${gadm}`, 'content-type': 'application/json' });
const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: headers(), payload: JSON.stringify(payload) });
const put = (url: string, payload: unknown) =>
  app.inject({ method: 'PUT', url, headers: headers(), payload: JSON.stringify(payload) });
const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${gadm}` } });
const del = (url: string) =>
  app.inject({ method: 'DELETE', url, headers: { authorization: `Bearer ${gadm}` } });

function makeCtx(opts: { schemaCheck?: boolean } = {}): ControlContext {
  const bus = new InMemoryConfigBus();
  bus.onSignal((s) => signals.push(s));
  return createInMemoryControlContext({
    pepper: 'durable-console-pepper-16chars!!!',
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: [SECRET],
    maxSessionTtlMs: 900_000,
    db,
    notifier: bus,
    ...opts,
  });
}

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await applyMigrations(client);
  gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  signals = [];
  ctx = makeCtx();
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
  orgId = ((await post('/orgs', { name: 'Acme' }).then((r) => r.json())) as { org: { id: string } })
    .org.id;
  workspaceId = (
    (await post('/workspaces', { orgId, name: 'prod' }).then((r) => r.json())) as {
      workspace: { id: string };
    }
  ).workspace.id;
});

afterAll(async () => {
  await app.close();
  await client.close();
});

describe('console CRUD is durable in DB mode (F2)', () => {
  it('a provider + credential + route created in the console land in Postgres, bump the version and signal', async () => {
    const v0 = await ctx.configVersions.currentVersion();
    const prov = await post('/providers', {
      workspaceId,
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(prov.statusCode).toBe(201);
    const providerId = (prov.json() as { provider: { id: string } }).provider.id;
    const cred = await post(`/providers/${providerId}/credential`, {
      secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:anthropic',
      secretVersion: 'v1',
    });
    expect(cred.statusCode).toBe(201);
    const route = await post('/routes', {
      workspaceId,
      name: 'primary',
      config: { strategy: 'single', target: 'anthropic' },
    });
    expect(route.statusCode).toBe(201);
    const routeId = (route.json() as { entity: { id: string } }).entity.id;

    // The GitOps export (what the gateway reconciles from) shows all three.
    const doc = await new PostgresConfigStore(db).exportDocument('*');
    const ws = doc.orgs.find((o) => o.name === 'Acme')!.workspaces.find((w) => w.name === 'prod')!;
    expect(ws.providers).toHaveLength(1);
    expect(ws.providers[0]).toMatchObject({ kind: 'anthropic', enabled: true });
    expect(ws.providers[0]!.credential).toMatchObject({ secretVersion: 'v1' });
    expect(ws.routes.map((r) => r.name)).toEqual(['primary']);

    // Three commits ⇒ three config versions, each signalled, each audited with the hash.
    expect(await ctx.configVersions.currentVersion()).toBe(v0 + 3);
    expect(signals.map((s) => s.v)).toEqual([v0 + 1, v0 + 2, v0 + 3]);
    const history = (await get('/config/versions/history?limit=5')).json() as {
      versions: Array<{ version: number; actor: string; summary: unknown }>;
    };
    expect(history.versions[0]).toMatchObject({ version: v0 + 3, actor: 'bootstrap-admin' });
    const events = (await get('/audit/events?limit=5')).json() as {
      events: Array<{ action: string; payload: Record<string, unknown> }>;
    };
    const row = events.events.find((e) => e.action === 'route.create')!;
    expect(row.payload['contentHash']).toMatch(/^[0-9a-f]{64}$/);
    // Drift: the last version's hash equals the live export.
    expect((await get('/config/drift')).json()).toMatchObject({ drifted: false });

    // Update + delete follow the same path (ids are the Postgres ids).
    const upd = await put(`/routes/${routeId}`, { name: 'primary-v2', config: { a: 1 } });
    expect(upd.statusCode).toBe(200);
    expect(await ctx.configVersions.currentVersion()).toBe(v0 + 4);
    const doc2 = await new PostgresConfigStore(db).exportDocument('*');
    expect(doc2.orgs[0]!.workspaces[0]!.routes[0]).toEqual({
      name: 'primary-v2',
      config: { a: 1 },
    });
    expect((await del(`/routes/${routeId}`)).statusCode).toBe(200);
    expect((await get('/routes')).json()).toMatchObject({ entities: [] });
  });

  it('a duplicate entity name in a workspace is a 409 (names are the reconcile key)', async () => {
    const a = await post('/policies', { workspaceId, name: 'p', config: { allow: ['x'] } });
    expect(a.statusCode).toBe(201);
    const dup = await post('/policies', { workspaceId, name: 'p', config: {} });
    expect(dup.statusCode).toBe(409);
    const b = await post('/policies', { workspaceId, name: 'q', config: {} });
    const bId = (b.json() as { entity: { id: string } }).entity.id;
    expect((await put(`/policies/${bId}`, { name: 'p' })).statusCode).toBe(409);
  });

  it('a second control-api process over the same database sees the console state after hydrate', async () => {
    const other = makeCtx();
    expect(other.providers.all()).toHaveLength(0);
    const counts = await other.hydrate!();
    expect(counts.providers).toBe(1);
    expect(other.providers.all()[0]).toMatchObject({ kind: 'anthropic', workspaceId });
    expect(other.credentials.get(other.providers.all()[0]!.id)?.credential).toMatchObject({
      secretVersion: 'v1',
    });
    expect(
      other.collections['policy']
        .all()
        .map((e) => e.name)
        .sort(),
    ).toEqual(['p', 'q']);
    expect(other.workspaces.get(workspaceId)?.name).toBe('prod');
  });

  it('PUT /providers/:id (enable/disable) is durable too', async () => {
    const id = ctx.providers.all()[0]!.id;
    const r = await put(`/providers/${id}`, { enabled: false });
    expect(r.statusCode).toBe(200);
    const doc = await new PostgresConfigStore(db).exportDocument('*');
    expect(doc.orgs[0]!.workspaces[0]!.providers[0]!.enabled).toBe(false);
    expect((await del(`/providers/${id}`)).statusCode).toBe(200);
    expect(
      (await new PostgresConfigStore(db).exportDocument('*')).orgs[0]!.workspaces[0]!.providers,
    ).toHaveLength(0);
  });
});

describe('durable prompt registry (F13/G10)', () => {
  it('creates, versions, verifies, lists and deletes through Postgres', async () => {
    const created = await post('/prompts', { workspaceId, name: 'greet', body: 'Hi {{name}}' });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { prompt: { id: string } }).prompt.id;
    expect((await post('/prompts', { workspaceId, name: 'greet', body: 'x' })).statusCode).toBe(
      409,
    );
    const v2 = await post(`/prompts/${id}/versions`, {
      body: 'Hi {{name}} from {{team}}',
      message: 'm',
    });
    expect(v2.statusCode).toBe(201);
    expect(
      (v2.json() as { version: { version: number; variables: string[] } }).version,
    ).toMatchObject({ version: 2, variables: ['name', 'team'] });
    expect((await get(`/prompts/${id}/verify`)).json()).toEqual({ verified: true, count: 2 });

    // A second process reads the same chain from the database.
    const other = makeCtx();
    const t = await other.prompts.get(id);
    expect(t?.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(await other.prompts.verifyChain(id)).toEqual({ verified: true, count: 2 });
    // Tampering with a stored author breaks the chain (the hash covers authorship).
    await db.execute(
      sql`update prompt_version set created_by = 'mallory' where template_id = ${id} and version = 1`,
    );
    expect((await get(`/prompts/${id}/verify`)).json()).toMatchObject({
      verified: false,
      brokenAt: 1,
    });

    const list = (await get('/prompts')).json() as {
      prompts: Array<{ name: string; latestVersion: number }>;
    };
    expect(list.prompts).toEqual(
      [{ name: 'greet', latestVersion: 2 }].map((x) => expect.objectContaining(x)),
    );
    expect((await get('/prompts/not-a-uuid')).statusCode).toBe(404);
    expect((await del(`/prompts/${id}`)).statusCode).toBe(200);
    expect((await get(`/prompts/${id}`)).statusCode).toBe(404);
  });
});

describe('schema-version readiness (S17)', () => {
  it('is degraded until the migrations table says the schema matches this build', async () => {
    const gated = makeCtx({ schemaCheck: true });
    const srv = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), gated);
    let r = await srv.inject({ method: 'GET', url: '/ready' });
    expect(r.statusCode).toBe(503);
    expect((r.json() as { reason: string }).reason).toMatch(/never applied/);
    await srv.close();

    // Simulate `db:migrate` having run for an OLDER build, then for this one.
    await db.execute(sql`create schema if not exists drizzle`);
    await db.execute(
      sql`create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`,
    );
    const expected = expectedSchemaMillis()!;
    await db.execute(
      sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('old', ${expected - 1})`,
    );
    const behind = makeCtx({ schemaCheck: true });
    const srv2 = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), behind);
    r = await srv2.inject({ method: 'GET', url: '/ready' });
    expect(r.statusCode).toBe(503);
    expect((r.json() as { reason: string }).reason).toMatch(/behind/);
    await srv2.close();

    await db.execute(
      sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('now', ${expected})`,
    );
    const current = makeCtx({ schemaCheck: true });
    const srv3 = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), current);
    r = await srv3.inject({ method: 'GET', url: '/ready' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'ready', schema: { ok: true, applied: expected } });
    await srv3.close();
  });
});
