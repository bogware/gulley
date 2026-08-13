import type { BatchVerifier, Signer } from '@gulley/crypto';
import { createHash } from 'node:crypto';

/** A non-PII audit row as mirrored to WORM. `createdAt` is a string end-to-end
 *  so the hash preimage is identical on the write and verify paths. */
export interface MirroredRow {
  seq: number;
  orgId: string | null;
  actor: string | null;
  action: string;
  target: string | null;
  payload: Record<string, unknown>;
  prevHash: string | null;
  rowHash: string;
  createdAt: string;
}

export interface MirrorBatch {
  firstSeq: number;
  lastSeq: number;
  rows: MirroredRow[];
  /** sha256(canonical(rows)) in base64. */
  batchHash: string;
  /** signer.sign(batchHash) — forgery needs the signing key, not just S3 Put. */
  signature: string;
}

export interface MirrorObjectRef {
  key: string;
  versionId?: string;
}

/** The retained WORM store. S3 Object Lock (COMPLIANCE) is the prod impl; the
 *  in-memory twin mirrors its semantics for CI. */
export interface AuditMirror {
  put(batch: MirrorBatch): Promise<MirrorObjectRef>;
  list(): Promise<MirrorObjectRef[]>;
  get(ref: MirrorObjectRef): Promise<MirrorBatch>;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = canonical(src[k]);
    return out;
  }
  return value;
}

export function batchHash(rows: MirroredRow[]): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(rows)))
    .digest('base64');
}

/** Build a signed batch from an ordered, contiguous run of rows. */
export async function buildBatch(rows: MirroredRow[], signer: Signer): Promise<MirrorBatch> {
  if (rows.length === 0) throw new Error('cannot build an empty batch');
  const hash = batchHash(rows);
  const signature = await signer.sign(Buffer.from(hash));
  return {
    firstSeq: rows[0]!.seq,
    lastSeq: rows[rows.length - 1]!.seq,
    rows,
    batchHash: hash,
    signature,
  };
}

export interface MirrorVerifyResult {
  ok: boolean;
  rows: number;
  lastSeq: number;
  reason?: string;
}

/**
 * Verify the mirrored chain: every batch's signature is authentic, its stored
 * hash matches a recomputation, the rowHash chain links across batches
 * (row.prevHash === previous row.rowHash), and sequence numbers are gapless.
 * S3 Object Lock makes the objects immutable; this proves nothing was inserted,
 * dropped, reordered, or forged.
 */
export async function verifyMirrorChain(
  mirror: AuditMirror,
  verifier: BatchVerifier,
): Promise<MirrorVerifyResult> {
  const refs = await mirror.list();
  const batches: MirrorBatch[] = [];
  for (const ref of refs) batches.push(await mirror.get(ref));
  batches.sort((a, b) => a.firstSeq - b.firstSeq);

  let prevHash: string | null = null;
  let expectedSeq: number | null = null;
  let count = 0;
  let lastSeq = 0;

  for (const batch of batches) {
    if (batchHash(batch.rows) !== batch.batchHash) {
      return { ok: false, rows: count, lastSeq, reason: `batch ${batch.firstSeq}: hash mismatch` };
    }
    if (!(await verifier.verify(Buffer.from(batch.batchHash), batch.signature))) {
      return { ok: false, rows: count, lastSeq, reason: `batch ${batch.firstSeq}: bad signature` };
    }
    for (const row of batch.rows) {
      if (expectedSeq !== null && row.seq !== expectedSeq) {
        return { ok: false, rows: count, lastSeq, reason: `seq gap at ${row.seq}` };
      }
      if (row.prevHash !== prevHash) {
        return { ok: false, rows: count, lastSeq, reason: `chain break at seq ${row.seq}` };
      }
      prevHash = row.rowHash;
      expectedSeq = row.seq + 1;
      lastSeq = row.seq;
      count++;
    }
  }
  return { ok: true, rows: count, lastSeq };
}

/** In-memory WORM twin: put is idempotent by key (deterministic window keys). */
export class InMemoryAuditMirror implements AuditMirror {
  private readonly byKey = new Map<string, MirrorBatch>();

  private keyFor(batch: MirrorBatch): string {
    return `audit/batch-${String(batch.firstSeq).padStart(12, '0')}-${batch.lastSeq}.json`;
  }

  async put(batch: MirrorBatch): Promise<MirrorObjectRef> {
    const key = this.keyFor(batch);
    this.byKey.set(key, batch);
    return { key };
  }
  async list(): Promise<MirrorObjectRef[]> {
    return [...this.byKey.keys()].map((key) => ({ key }));
  }
  async get(ref: MirrorObjectRef): Promise<MirrorBatch> {
    const b = this.byKey.get(ref.key);
    if (!b) throw new Error(`no such mirror object: ${ref.key}`);
    return b;
  }
}
