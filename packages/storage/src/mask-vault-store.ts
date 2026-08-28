import { and, eq, lt, sql } from 'drizzle-orm';

import type { Database } from './db';
import { maskVault } from './schema';

export type MaskDirection = 'input' | 'output';

/** A stored reversal record: the ENCRYPTED token↔original map for a masked request,
 *  plus the metadata a reveal needs for its RBAC check. `ciphertext` is an opaque
 *  `EnvelopeCiphertext` (from @gulley/crypto) — the store never sees plaintext. */
export interface MaskVaultRecord {
  requestId: string;
  direction: MaskDirection;
  workspaceId: string;
  orgId: string | null;
  ciphertext: unknown;
  tokenCount: number;
  ttlSeconds: number;
}

export interface MaskVaultView {
  requestId: string;
  direction: MaskDirection;
  workspaceId: string;
  orgId: string | null;
  ciphertext: unknown;
  tokenCount: number;
}

/** Read/write port for the durable mask-reversal store, so the gateway (write) and
 *  control-api reveal endpoint (read) share one contract. */
export interface MaskVaultStore {
  put(record: MaskVaultRecord): Promise<void>;
  get(requestId: string, direction: MaskDirection): Promise<MaskVaultView | undefined>;
  /** All non-expired directions for a request (the reveal endpoint). */
  list(requestId: string): Promise<MaskVaultView[]>;
  sweepExpired(now: Date): Promise<number>;
}

/**
 * Postgres-backed {@link MaskVaultStore}. Stores ONLY the `EnvelopeCiphertext` jsonb
 * (encrypt/decrypt live in the app layer with @gulley/crypto), TTL-bounded with an
 * `expiresAt` sweep. Reads filter out expired rows so an expired reversal record is
 * invisible even before the sweep runs.
 */
export class PostgresMaskVaultStore implements MaskVaultStore {
  constructor(private readonly db: Database) {}

  async put(record: MaskVaultRecord): Promise<void> {
    const expiresAt = new Date(Date.now() + record.ttlSeconds * 1000);
    await this.db
      .insert(maskVault)
      .values({
        requestId: record.requestId,
        direction: record.direction,
        workspaceId: record.workspaceId,
        orgId: record.orgId,
        ciphertext: record.ciphertext,
        tokenCount: record.tokenCount,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [maskVault.requestId, maskVault.direction],
        set: { ciphertext: record.ciphertext, tokenCount: record.tokenCount, expiresAt },
      });
  }

  private toView(r: typeof maskVault.$inferSelect): MaskVaultView {
    return {
      requestId: r.requestId,
      direction: r.direction as MaskDirection,
      workspaceId: r.workspaceId,
      orgId: r.orgId,
      ciphertext: r.ciphertext,
      tokenCount: r.tokenCount,
    };
  }

  async get(requestId: string, direction: MaskDirection): Promise<MaskVaultView | undefined> {
    const rows = await this.db
      .select()
      .from(maskVault)
      .where(
        and(
          eq(maskVault.requestId, requestId),
          eq(maskVault.direction, direction),
          sql`${maskVault.expiresAt} > now()`,
        ),
      )
      .limit(1);
    const r = rows[0];
    return r ? this.toView(r) : undefined;
  }

  async list(requestId: string): Promise<MaskVaultView[]> {
    const rows = await this.db
      .select()
      .from(maskVault)
      .where(and(eq(maskVault.requestId, requestId), sql`${maskVault.expiresAt} > now()`));
    return rows.map((r) => this.toView(r));
  }

  async sweepExpired(now: Date): Promise<number> {
    const res = await this.db.delete(maskVault).where(lt(maskVault.expiresAt, now));
    return (res as unknown as { rowCount?: number }).rowCount ?? 0;
  }
}
