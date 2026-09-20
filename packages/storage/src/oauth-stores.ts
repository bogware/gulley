import type {
  AuthCode,
  AuthCodeStore,
  DeviceCode,
  DeviceCodeStore,
  DeviceStatus,
  Grant,
  GrantStore,
  OAuthClient,
  OAuthClientStore,
  RotateFields,
} from '@gulley/oauth';
import { and, eq, sql } from 'drizzle-orm';

import type { Database } from './db';
import { authCode, deviceCode, oauthClient, oauthGrant } from './schema';

/**
 * Affected-row count from a drizzle non-returning UPDATE, portable across drivers:
 * postgres-js Result is an Array subclass with `.count` (NO rowCount); pglite exposes
 * `.rowCount`. A generation-guarded CAS therefore MUST read this — never Array.isArray,
 * which is always true on the postgres-js Result and reports a lost race as a success.
 */
import { affectedRows } from './affected-rows';

const ms = (d: Date | null): number => (d ? d.getTime() : 0);
const dt = (n: number): Date => new Date(n);

/** Durable token-family store. Mirrors InMemoryGrantStore; `rotate` uses a
 *  generation-guarded UPDATE for optimistic concurrency (a lost race updates 0 rows). */
export class PostgresGrantStore implements GrantStore {
  constructor(private readonly db: Database) {}

  async create(g: Grant): Promise<void> {
    await this.db.insert(oauthGrant).values({
      handle: g.handle,
      clientId: g.clientId,
      principalId: g.principalId,
      displayName: g.displayName,
      orgId: g.orgId,
      workspaceId: g.workspaceId,
      status: g.status,
      accessTokenHash: g.accessTokenHash,
      accessTokenExpiresAt: g.accessTokenExpiresAt ? dt(g.accessTokenExpiresAt) : null,
      refreshTokenHash: g.refreshTokenHash,
      prevRefreshTokenHash: g.prevRefreshTokenHash,
      refreshGeneration: g.refreshGeneration,
      absoluteExpiresAt: dt(g.absoluteExpiresAt),
    });
  }

  async get(handle: string): Promise<Grant | null> {
    const [r] = await this.db
      .select()
      .from(oauthGrant)
      .where(eq(oauthGrant.handle, handle))
      .limit(1);
    if (!r) return null;
    return {
      handle: r.handle,
      clientId: r.clientId,
      principalId: r.principalId,
      displayName: r.displayName,
      orgId: r.orgId,
      workspaceId: r.workspaceId,
      status: r.status as Grant['status'],
      accessTokenHash: r.accessTokenHash,
      accessTokenExpiresAt: ms(r.accessTokenExpiresAt),
      refreshTokenHash: r.refreshTokenHash,
      prevRefreshTokenHash: r.prevRefreshTokenHash,
      refreshGeneration: r.refreshGeneration,
      absoluteExpiresAt: ms(r.absoluteExpiresAt),
    };
  }

  async revoke(handle: string): Promise<boolean> {
    const res = await this.db
      .update(oauthGrant)
      .set({ status: 'revoked' })
      .where(eq(oauthGrant.handle, handle));
    return affectedRows(res) > 0;
  }

  async setAccess(handle: string, hash: string, expiresAt: number): Promise<void> {
    await this.db
      .update(oauthGrant)
      .set({ accessTokenHash: hash, accessTokenExpiresAt: dt(expiresAt) })
      .where(eq(oauthGrant.handle, handle));
  }

  async rotate(handle: string, expectedGen: number, next: RotateFields): Promise<boolean> {
    // Generation-guarded CAS: only applies if still active AND at expectedGen.
    const res = await this.db
      .update(oauthGrant)
      .set({
        accessTokenHash: next.accessTokenHash,
        accessTokenExpiresAt: dt(next.accessTokenExpiresAt),
        refreshTokenHash: next.refreshTokenHash,
        prevRefreshTokenHash: next.prevRefreshTokenHash,
        refreshGeneration: next.refreshGeneration,
      })
      .where(
        and(
          eq(oauthGrant.handle, handle),
          eq(oauthGrant.status, 'active'),
          eq(oauthGrant.refreshGeneration, expectedGen),
        ),
      );
    return affectedRows(res) === 1;
  }

  /** Console listing (secret-free): active grants, newest first. */
  async list(
    limit = 200,
  ): Promise<Array<Omit<Grant, 'accessTokenHash' | 'refreshTokenHash' | 'prevRefreshTokenHash'>>> {
    const rows = await this.db
      .select()
      .from(oauthGrant)
      .orderBy(sql`${oauthGrant.createdAt} desc`)
      .limit(limit);
    return rows.map((r) => ({
      handle: r.handle,
      clientId: r.clientId,
      principalId: r.principalId,
      displayName: r.displayName,
      orgId: r.orgId,
      workspaceId: r.workspaceId,
      status: r.status as Grant['status'],
      accessTokenExpiresAt: ms(r.accessTokenExpiresAt),
      refreshGeneration: r.refreshGeneration,
      absoluteExpiresAt: ms(r.absoluteExpiresAt),
    }));
  }
}

export class PostgresDeviceCodeStore implements DeviceCodeStore {
  constructor(private readonly db: Database) {}

  async create(d: DeviceCode): Promise<void> {
    await this.db.insert(deviceCode).values({
      deviceCode: d.deviceCode,
      userCode: d.userCode,
      clientId: d.clientId,
      status: d.status,
      principalId: d.principalId ?? null,
      displayName: d.displayName ?? null,
      expiresAt: dt(d.expiresAt),
      lastPolledAt: d.lastPolledAt,
      intervalMs: d.intervalMs,
    });
  }

  private map(r: typeof deviceCode.$inferSelect): DeviceCode {
    return {
      deviceCode: r.deviceCode,
      userCode: r.userCode,
      clientId: r.clientId,
      status: r.status as DeviceStatus,
      principalId: r.principalId ?? undefined,
      displayName: r.displayName ?? undefined,
      expiresAt: ms(r.expiresAt),
      lastPolledAt: r.lastPolledAt,
      intervalMs: r.intervalMs,
    };
  }

  async getByDeviceCode(dc: string): Promise<DeviceCode | null> {
    const [r] = await this.db
      .select()
      .from(deviceCode)
      .where(eq(deviceCode.deviceCode, dc))
      .limit(1);
    return r ? this.map(r) : null;
  }
  async getByUserCode(uc: string): Promise<DeviceCode | null> {
    const [r] = await this.db.select().from(deviceCode).where(eq(deviceCode.userCode, uc)).limit(1);
    return r ? this.map(r) : null;
  }
  async update(dc: string, patch: Partial<DeviceCode>): Promise<void> {
    const set: Record<string, unknown> = {};
    if (patch.status !== undefined) set['status'] = patch.status;
    if (patch.principalId !== undefined) set['principalId'] = patch.principalId;
    if (patch.displayName !== undefined) set['displayName'] = patch.displayName;
    if (patch.lastPolledAt !== undefined) set['lastPolledAt'] = patch.lastPolledAt;
    if (Object.keys(set).length > 0)
      await this.db.update(deviceCode).set(set).where(eq(deviceCode.deviceCode, dc));
  }
  async transition(dc: string, from: DeviceStatus, to: DeviceStatus): Promise<boolean> {
    const res = await this.db
      .update(deviceCode)
      .set({ status: to })
      .where(and(eq(deviceCode.deviceCode, dc), eq(deviceCode.status, from)));
    return affectedRows(res) === 1;
  }
  async list(limit = 100): Promise<DeviceCode[]> {
    const rows = await this.db
      .select()
      .from(deviceCode)
      .orderBy(sql`${deviceCode.expiresAt} desc`)
      .limit(limit);
    return rows.map((r) => this.map(r));
  }
}

export class PostgresAuthCodeStore implements AuthCodeStore {
  constructor(private readonly db: Database) {}
  async create(c: AuthCode): Promise<void> {
    await this.db.insert(authCode).values({
      code: c.code,
      clientId: c.clientId,
      redirectUri: c.redirectUri,
      codeChallenge: c.codeChallenge,
      principalId: c.principalId,
      displayName: c.displayName,
      orgId: c.orgId,
      workspaceId: c.workspaceId,
      expiresAt: dt(c.expiresAt),
    });
  }
  /** Claim-first single use: DELETE ... RETURNING so a concurrent consume gets null. */
  async consume(code: string): Promise<AuthCode | null> {
    const rows = await this.db.delete(authCode).where(eq(authCode.code, code)).returning();
    const r = rows[0];
    if (!r) return null;
    return {
      code: r.code,
      clientId: r.clientId,
      redirectUri: r.redirectUri,
      codeChallenge: r.codeChallenge,
      principalId: r.principalId,
      displayName: r.displayName,
      orgId: r.orgId,
      workspaceId: r.workspaceId,
      expiresAt: ms(r.expiresAt),
    };
  }
}

export class PostgresOAuthClientStore implements OAuthClientStore {
  constructor(private readonly db: Database) {}
  private map(r: typeof oauthClient.$inferSelect): OAuthClient {
    return {
      clientId: r.clientId,
      name: r.name,
      orgId: r.orgId,
      workspaceId: r.workspaceId,
      grantTypes: (r.grantTypes as string[]) ?? [],
      redirectAllowlist: (r.redirectAllowlist as string[]) ?? [],
      enabled: r.enabled,
    };
  }
  async get(clientId: string): Promise<OAuthClient | null> {
    const [r] = await this.db
      .select()
      .from(oauthClient)
      .where(eq(oauthClient.clientId, clientId))
      .limit(1);
    return r ? this.map(r) : null;
  }
  async list(): Promise<OAuthClient[]> {
    const rows = await this.db
      .select()
      .from(oauthClient)
      .orderBy(sql`${oauthClient.createdAt} desc`);
    return rows.map((r) => this.map(r));
  }
  async upsert(c: OAuthClient): Promise<void> {
    await this.db
      .insert(oauthClient)
      .values({
        clientId: c.clientId,
        name: c.name,
        orgId: c.orgId,
        workspaceId: c.workspaceId,
        grantTypes: [...c.grantTypes],
        redirectAllowlist: [...c.redirectAllowlist],
        enabled: c.enabled,
      })
      .onConflictDoUpdate({
        target: oauthClient.clientId,
        // Tenancy is part of the upsert: re-saving a client with a new org/workspace
        // previously kept the OLD scope while the audit row recorded the requested one.
        set: {
          name: c.name,
          orgId: c.orgId,
          workspaceId: c.workspaceId,
          grantTypes: [...c.grantTypes],
          redirectAllowlist: [...c.redirectAllowlist],
          enabled: c.enabled,
        },
      });
  }
  async delete(clientId: string): Promise<boolean> {
    const rows = await this.db
      .delete(oauthClient)
      .where(eq(oauthClient.clientId, clientId))
      .returning();
    return rows.length > 0;
  }
}
