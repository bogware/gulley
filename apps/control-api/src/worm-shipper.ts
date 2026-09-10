import type { BatchVerifier, Signer } from '@gulley/crypto';
import type { AuditRow } from '@gulley/pipeline';
import { type AuditMirror, buildBatch, type MirroredRow, verifyMirrorChain } from '@gulley/worm';

/**
 * WORM-live: continuously mirror the durable, hash-chained audit log to the retained
 * S3 Object Lock (COMPLIANCE) system of record. The gateway/control-api write rows to
 * Postgres (the queryable projection); this ships them, in signed contiguous batches,
 * to immutable storage — so the record survives a Postgres compromise and is provably
 * un-tampered (Object Lock immutability + the cross-batch hash chain + a batch
 * signature). Raw PII never enters WORM: only the non-PII AuditRow metadata does
 * (payloads are already redacted by GuardedAuditSink upstream).
 *
 * Correctness: it ships from the COMPLETE durable chain (readRows), NOT the
 * fire-and-forget append callback, so a rolled-back/dropped append never produces an
 * immutable, incomplete artifact; and it refuses to ship on top of an existing WORM
 * record that fails its own integrity check (fail-closed).
 */
export function toMirroredRow(r: AuditRow): MirroredRow {
  return {
    seq: r.seq,
    orgId: r.orgId ?? null,
    actor: r.actor ?? null,
    action: r.action,
    target: r.target ?? null,
    payload: r.payload ?? {},
    prevHash: r.prevHash,
    rowHash: r.rowHash,
    createdAt: r.createdAt.toISOString(),
  };
}

export interface WormShipperDeps {
  mirror: AuditMirror;
  signer: Signer;
  verifier: BatchVerifier;
  /** Read the durable audit chain seq-ascending. Pass `sinceSeq` to read only the
   *  incremental tail (`seq > sinceSeq`) so a long-lived chain isn't pulled whole every
   *  tick; omit for the full chain (readAuditRows(db, sinceSeq?)). */
  readRows: (sinceSeq?: number) => Promise<AuditRow[]>;
  /** Max rows per WORM object. Default 100. */
  batchMax?: number;
  log?: (msg: string) => void;
}

export interface ShipResult {
  shipped: number;
  lastSeq: number;
}

export class WormShipper {
  private lastShippedSeq = 0;
  private resolved = false;
  private inFlight = false;

  constructor(private readonly deps: WormShipperDeps) {}

  get lastSeq(): number {
    return this.lastShippedSeq;
  }

  /** Verify the CURRENT WORM record (immutability is enforced by S3; this proves
   *  nothing was inserted, dropped, reordered, or forged). */
  verify(): ReturnType<typeof verifyMirrorChain> {
    return verifyMirrorChain(this.deps.mirror, this.deps.verifier);
  }

  private async resolveLastShipped(): Promise<void> {
    if (this.resolved) return;
    // An empty mirror verifies ok (rows: 0). ANY failure over a non-empty record —
    // a bad signature or hash on even the first batch (rows can still be 0 there),
    // a seq gap, a broken link — means the immutable record is compromised or the
    // signing key is wrong: refuse to append rather than extend a broken chain.
    const res = await verifyMirrorChain(this.deps.mirror, this.deps.verifier);
    if (!res.ok) {
      throw new Error(`WORM chain integrity check failed (${res.reason}) — refusing to ship`);
    }
    this.lastShippedSeq = res.lastSeq; // 0 for an empty mirror
    this.resolved = true;
  }

  /** Ship all durable rows with seq > lastShippedSeq to WORM in contiguous, signed
   *  batches. Idempotent (deterministic batch keys) and single-flight. */
  async ship(): Promise<ShipResult> {
    if (this.inFlight) return { shipped: 0, lastSeq: this.lastShippedSeq };
    this.inFlight = true;
    try {
      await this.resolveLastShipped();
      // Bounded tail read: resolveLastShipped() has set lastShippedSeq from the mirror
      // head, so ask only for rows past it (identical set to the old read-then-filter,
      // but the DB no longer returns the whole chain). The JS filter/sort stays as a
      // belt-and-suspenders guard against an out-of-order or unfiltered backend.
      const rows = await this.deps.readRows(this.lastShippedSeq);
      const pending = rows.filter((r) => r.seq > this.lastShippedSeq).sort((a, b) => a.seq - b.seq);
      if (pending.length === 0) return { shipped: 0, lastSeq: this.lastShippedSeq };
      const max = this.deps.batchMax ?? 100;
      let shipped = 0;
      for (let i = 0; i < pending.length; i += max) {
        const chunk = pending.slice(i, i + max).map(toMirroredRow);
        const batch = await buildBatch(chunk, this.deps.signer);
        await this.deps.mirror.put(batch);
        shipped += chunk.length;
        this.lastShippedSeq = chunk[chunk.length - 1]!.seq;
      }
      this.deps.log?.(`WORM: shipped ${shipped} audit row(s) up to seq ${this.lastShippedSeq}`);
      return { shipped, lastSeq: this.lastShippedSeq };
    } finally {
      this.inFlight = false;
    }
  }
}
