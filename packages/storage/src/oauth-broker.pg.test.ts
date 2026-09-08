import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { BrokerService, SimulatedIdp } from '@gulley/oauth';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from './db';
import {
  PostgresAuthCodeStore,
  PostgresDeviceCodeStore,
  PostgresGrantStore,
  PostgresOAuthClientStore,
} from './oauth-stores';
import * as schema from './schema';

let client: PGlite;
let db: Database;

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

const ORG = '11111111-1111-1111-1111-111111111111';
const WS = '22222222-2222-2222-2222-222222222222';
const PEPPER = 'oauth-broker-pglite-pepper-16chars';

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await applyMigrations(client);
  await db.insert(schema.org).values({ id: ORG, name: 'Acme' });
  await db.insert(schema.workspace).values({ id: WS, orgId: ORG, name: 'prod' });
});
afterAll(async () => {
  await client.close();
});

function broker(onReuse?: (g: unknown) => void): BrokerService {
  return new BrokerService(
    {
      pepper: PEPPER,
      accessTtlMs: 3_600_000,
      refreshTtlMs: 30 * 86_400_000,
      absoluteTtlMs: 90 * 86_400_000,
      deviceCodeTtlMs: 900_000,
      deviceIntervalMs: 0,
      onReuse: onReuse as never,
    },
    {
      grants: new PostgresGrantStore(db),
      devices: new PostgresDeviceCodeStore(db),
      codes: new PostgresAuthCodeStore(db),
      clients: new PostgresOAuthClientStore(db),
      idp: new SimulatedIdp(),
    },
  );
}

async function seedClient(clientId: string): Promise<void> {
  await new PostgresOAuthClientStore(db).upsert({
    clientId,
    name: clientId,
    orgId: ORG,
    workspaceId: WS,
    grantTypes: ['device_code', 'refresh_token', 'authorization_code'],
    redirectAllowlist: ['/cb'],
    enabled: true,
  });
}

async function issue(
  b: BrokerService,
  clientId: string,
): Promise<{ access: string; refresh: string }> {
  const da = await b.deviceAuthorization(clientId);
  expect(da.ok).toBe(true);
  if (!da.ok) throw new Error('device auth failed');
  const approved = await b.deviceApprove(da.value.user_code, {
    subject: 'user-1',
    displayName: 'Alice',
  });
  expect(approved.ok).toBe(true);
  const tok = await b.tokenDeviceCode(da.value.device_code, clientId);
  expect(tok.ok).toBe(true);
  if (!tok.ok) throw new Error('token failed');
  return { access: tok.value.access_token, refresh: tok.value.refresh_token };
}

describe('OAuth broker over durable Postgres stores (pglite)', () => {
  it('device flow issues a tenancy-scoped grant resolvable by access token', async () => {
    await seedClient('claude-code');
    const b = broker();
    const { access } = await issue(b, 'claude-code');
    const p = await b.resolveBrokerToken(access);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.value.scope.orgId).toBe(ORG);
      expect(p.value.scope.workspaceId).toBe(WS);
    }
  });

  it('refresh rotates; replaying the superseded refresh revokes the family and fires onReuse', async () => {
    await seedClient('codex');
    const onReuse = vi.fn();
    const b = broker(onReuse);
    const fam = await issue(b, 'codex');

    const rotated = await b.refresh(fam.refresh, 'codex');
    expect(rotated.ok).toBe(true); // the CAS rotate succeeded (affectedRows fix)

    const reuse = await b.refresh(fam.refresh, 'codex'); // superseded → theft
    expect(reuse.ok).toBe(false);
    expect(onReuse).toHaveBeenCalledTimes(1);
    // The whole family is dead: the original access token no longer resolves.
    expect((await b.resolveBrokerToken(fam.access)).ok).toBe(false);
  });

  it('a device code cannot be redeemed twice (claim-first transition guard)', async () => {
    await seedClient('cc2');
    const b = broker();
    const da = await b.deviceAuthorization('cc2');
    if (!da.ok) throw new Error('da');
    await b.deviceApprove(da.value.user_code, { subject: 'u', displayName: 'U' });
    const first = await b.tokenDeviceCode(da.value.device_code, 'cc2');
    const second = await b.tokenDeviceCode(da.value.device_code, 'cc2');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false); // already redeemed
  });
});
