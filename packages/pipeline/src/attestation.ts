import { createHmac, timingSafeEqual } from 'node:crypto';

import { type AuditRow, canonicalize, computeRowHash, rowContent } from './audit';

/** Result of an independent walk of the audit hash chain — the evidence an
 *  auditor attestation is built from. */
export interface AuditChainReport {
  verified: boolean;
  count: number;
  firstSeq: number | null;
  lastSeq: number | null;
  firstHash: string | null;
  lastHash: string | null;
  firstAt: string | null;
  lastAt: string | null;
  /** The seq at which verification first failed (absent when verified). */
  brokenAtSeq?: number;
}

/** Re-walk the chain, recomputing every row hash from its predecessor and
 *  confirming the prev-pointer + monotonic seq. Pure; the single source of truth
 *  for both the in-memory sink's `verify()` and the audit-verify CLI. Rows MUST be
 *  ordered by seq ascending. */
export function verifyAuditChain(rows: readonly AuditRow[]): AuditChainReport {
  const first = rows[0];
  const last = rows[rows.length - 1];
  const base: AuditChainReport = {
    verified: true,
    count: rows.length,
    firstSeq: first?.seq ?? null,
    lastSeq: last?.seq ?? null,
    firstHash: first?.rowHash ?? null,
    lastHash: last?.rowHash ?? null,
    firstAt: first ? first.createdAt.toISOString() : null,
    lastAt: last ? last.createdAt.toISOString() : null,
  };

  let prev: string | null = null;
  let prevSeq = 0;
  for (const row of rows) {
    const content = rowContent(row);
    const linkBroken = row.prevHash !== prev || computeRowHash(prev, content) !== row.rowHash;
    const seqBroken = row.seq <= prevSeq;
    if (linkBroken || seqBroken) {
      return { ...base, verified: false, brokenAtSeq: row.seq };
    }
    prev = row.rowHash;
    prevSeq = row.seq;
  }
  return base;
}

/** A tamper-evidence attestation over an audit chain — what an auditor receives. */
export interface AuditAttestation {
  tool: string;
  toolVersion: string;
  generatedAt: string;
  /** Optional operator label (deployment / environment / org). */
  subject?: string;
  chain: AuditChainReport;
}

export interface SignedAttestation {
  attestation: AuditAttestation;
  algorithm: 'HMAC-SHA256';
  /** Hex HMAC over the canonical attestation. */
  signature: string;
}

/** Sign an attestation with an operator-held key (HMAC-SHA256 over the canonical
 *  JSON). The key is a shared secret the auditor also holds to verify. */
export function signAttestation(attestation: AuditAttestation, key: string): SignedAttestation {
  const signature = createHmac('sha256', key).update(canonicalize(attestation)).digest('hex');
  return { attestation, algorithm: 'HMAC-SHA256', signature };
}

/** Constant-time verification of a signed attestation. */
export function verifyAttestation(doc: SignedAttestation, key: string): boolean {
  if (doc.algorithm !== 'HMAC-SHA256') return false;
  const expected = createHmac('sha256', key).update(canonicalize(doc.attestation)).digest('hex');
  const a = Buffer.from(doc.signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Verify a chain and package a signed attestation in one step. */
export function attestAuditChain(
  rows: readonly AuditRow[],
  opts: { key: string; subject?: string; toolVersion: string; generatedAt: string },
): SignedAttestation {
  const chain = verifyAuditChain(rows);
  const attestation: AuditAttestation = {
    tool: 'gulley-audit-verify',
    toolVersion: opts.toolVersion,
    generatedAt: opts.generatedAt,
    ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
    chain,
  };
  return signAttestation(attestation, opts.key);
}
