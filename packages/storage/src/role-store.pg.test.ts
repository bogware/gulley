import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db';
import { BuiltinRoleError, PostgresRoleStore } from './role-store';
import * as schema from './schema';

let client: PGlite;
let db: Database;
let roles: PostgresRoleStore;

async function applyMigrations(pg: PGlite): Promise<void> {
  const dir = fileURLToPath(new URL('../migrations', import.meta.url));
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

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await applyMigrations(client);
  roles = new PostgresRoleStore(db);
});

afterAll(async () => {
  await client.close();
});

describe('PostgresRoleStore', () => {
  it('migration 0028 seeds the five built-ins as immutable rows', async () => {
    const all = await roles.list();
    const builtins = all.filter((r) => r.builtin).map((r) => r.id);
    expect(builtins.sort()).toEqual(['admin', 'billing', 'editor', 'owner', 'viewer']);
    const owner = await roles.get('owner');
    expect(owner?.permissions).toContain('membership:grant_owner');
    expect(owner?.permissions).toContain('key:rotate');
    const viewer = await roles.get('viewer');
    expect(viewer?.permissions).toContain('role:read');
    expect(viewer?.permissions).not.toContain('key:create');
    await expect(roles.update('owner', { name: 'root' })).rejects.toBeInstanceOf(BuiltinRoleError);
    await expect(roles.delete('viewer')).rejects.toBeInstanceOf(BuiltinRoleError);
  });

  it('creates, updates, lists and deletes a custom role', async () => {
    const created = await roles.create('key-operator', {
      name: 'Key operator',
      description: 'disable + rotate only',
      permissions: ['key:read', 'key:disable', 'key:rotate'],
    });
    expect(created).toMatchObject({
      id: 'key-operator',
      builtin: false,
      orgId: null,
      permissions: ['key:read', 'key:disable', 'key:rotate'],
    });
    expect((await roles.list()).some((r) => r.id === 'key-operator')).toBe(true);

    const updated = await roles.update('key-operator', { permissions: ['key:disable'] });
    expect(updated?.permissions).toEqual(['key:disable']);
    expect(updated?.name).toBe('Key operator'); // untouched field kept
    expect(Date.parse(updated!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt));

    expect(await roles.delete('key-operator')).toBe(true);
    expect(await roles.delete('key-operator')).toBe(false);
    expect(await roles.update('key-operator', { name: 'x' })).toBeUndefined();
    expect(await roles.get('key-operator')).toBeUndefined();
  });

  it('refuses a duplicate id at the database', async () => {
    await roles.create('dup', { name: 'dup', permissions: [] });
    await expect(roles.create('dup', { name: 'dup2', permissions: [] })).rejects.toThrow();
    await roles.delete('dup');
  });

  it('ensureBuiltins re-syncs a built-in row with the code definition', async () => {
    await db.execute(`update "role" set permissions = '["org:read"]'::jsonb where id = 'viewer'`);
    expect((await roles.get('viewer'))?.permissions).toEqual(['org:read']);
    await roles.ensureBuiltins([
      { id: 'viewer', name: 'viewer', description: 'ro', permissions: ['org:read', 'role:read'] },
      { id: 'auditor', name: 'auditor', permissions: ['audit:read'] },
    ]);
    const viewer = await roles.get('viewer');
    expect(viewer?.permissions).toEqual(['org:read', 'role:read']);
    expect(viewer?.builtin).toBe(true);
    // A definition not yet present is inserted as built-in.
    expect((await roles.get('auditor'))?.builtin).toBe(true);
  });
});
