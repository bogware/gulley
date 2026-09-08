import type { AdminSessionInfo, AdminSessionStore } from '@gulley/auth';
import { eq, sql } from 'drizzle-orm';

import type { Database } from './db';
import { adminSession } from './schema';

/**
 * Durable admin-session registry. `record` logs a minted session (for the console's
 * live-session view); `revoke` marks it revoked (an upsert, so a jti minted before the
 * registry existed can still be killed); `isActive` stays revocation-only — a jti is
 * active unless an explicit revoked row exists, preserving the stateless-JWT semantics.
 */
export class PostgresAdminSessionStore implements AdminSessionStore {
  constructor(private readonly db: Database) {}

  async isActive(jti: string): Promise<boolean> {
    const [r] = await this.db
      .select({ revoked: adminSession.revoked })
      .from(adminSession)
      .where(eq(adminSession.jti, jti))
      .limit(1);
    return r?.revoked !== true;
  }

  async revoke(jti: string): Promise<void> {
    // token_hash carries a UNIQUE index; this registry keys by jti (PK) and never looks
    // rows up by hash, so the jti doubles as a guaranteed-unique placeholder value.
    await this.db
      .insert(adminSession)
      .values({ jti, tokenHash: jti, subject: '', expiresAt: new Date(), revoked: true })
      .onConflictDoUpdate({ target: adminSession.jti, set: { revoked: true } });
  }

  async record(rec: Omit<AdminSessionInfo, 'revoked'>): Promise<void> {
    await this.db
      .insert(adminSession)
      .values({
        jti: rec.jti,
        tokenHash: rec.jti,
        subject: rec.subject,
        source: rec.source,
        createdAt: new Date(rec.createdAt),
        expiresAt: new Date(rec.expiresAt),
      })
      .onConflictDoUpdate({
        target: adminSession.jti,
        set: {
          subject: rec.subject,
          source: rec.source,
          createdAt: new Date(rec.createdAt),
          expiresAt: new Date(rec.expiresAt),
        },
      });
  }

  async list(): Promise<AdminSessionInfo[]> {
    const rows = await this.db
      .select()
      .from(adminSession)
      .orderBy(sql`${adminSession.createdAt} desc`)
      .limit(500);
    return rows.map((r) => ({
      jti: r.jti,
      subject: r.subject,
      source: r.source,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      revoked: r.revoked,
    }));
  }
}
