import { createHmac, createPublicKey, timingSafeEqual, verify as nodeVerify } from 'node:crypto';

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
  const walker = new AuditChainWalker();
  for (const row of rows) walker.push(row);
  return walker.report();
}

/**
 * Incremental chain verifier: feed rows seq-ascending one (or one batch) at a time and
 * read the report at the end. Same semantics as {@link verifyAuditChain} — that function
 * is now a thin wrapper — but lets a durable backend re-walk a chain of any size in
 * bounded batches instead of materialising every row. After the first broken link the
 * walker stops re-hashing (the report is final); `push` stays cheap.
 */
export class AuditChainWalker {
  private prev: string | null = null;
  private prevSeq = 0;
  private count = 0;
  private first: AuditRow | undefined;
  private last: AuditRow | undefined;
  private brokenAtSeq: number | undefined;

  push(row: AuditRow): void {
    this.count++;
    this.first ??= row;
    this.last = row;
    if (this.brokenAtSeq !== undefined) return;
    const content = rowContent(row);
    const linkBroken =
      row.prevHash !== this.prev || computeRowHash(this.prev, content) !== row.rowHash;
    const seqBroken = row.seq <= this.prevSeq;
    if (linkBroken || seqBroken) {
      this.brokenAtSeq = row.seq;
      return;
    }
    this.prev = row.rowHash;
    this.prevSeq = row.seq;
  }

  report(): AuditChainReport {
    const { first, last } = this;
    const base: AuditChainReport = {
      verified: this.brokenAtSeq === undefined,
      count: this.count,
      firstSeq: first?.seq ?? null,
      lastSeq: last?.seq ?? null,
      firstHash: first?.rowHash ?? null,
      lastHash: last?.rowHash ?? null,
      firstAt: first ? first.createdAt.toISOString() : null,
      lastAt: last ? last.createdAt.toISOString() : null,
    };
    return this.brokenAtSeq === undefined ? base : { ...base, brokenAtSeq: this.brokenAtSeq };
  }
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

/** How a {@link SignedAttestation} was signed. HMAC-SHA256 is the shared-secret twin
 *  (hex signature); the asymmetric algorithms are KMS-signed (base64 signature) and
 *  verifiable offline with only the published public key. */
export type AttestationAlgorithm =
  | 'HMAC-SHA256'
  | 'ECDSA_SHA_256'
  | 'ECDSA_SHA_384'
  | 'ECDSA_SHA_512'
  | 'RSASSA_PKCS1_V1_5_SHA_256'
  | 'RSASSA_PKCS1_V1_5_SHA_384'
  | 'RSASSA_PKCS1_V1_5_SHA_512';

const ASYM_HASH: Record<string, 'sha256' | 'sha384' | 'sha512'> = {
  ECDSA_SHA_256: 'sha256',
  ECDSA_SHA_384: 'sha384',
  ECDSA_SHA_512: 'sha512',
  RSASSA_PKCS1_V1_5_SHA_256: 'sha256',
  RSASSA_PKCS1_V1_5_SHA_384: 'sha384',
  RSASSA_PKCS1_V1_5_SHA_512: 'sha512',
};

export interface SignedAttestation {
  attestation: AuditAttestation;
  algorithm: AttestationAlgorithm;
  /** Hex HMAC (HMAC-SHA256) or base64 asymmetric signature over the canonical
   *  attestation. */
  signature: string;
}

/** A structural async signer (e.g. @gulley/crypto's KmsSigner) — kept structural so
 *  the pipeline package takes no dependency on the crypto/KMS SDK. Returns a base64
 *  signature over the given bytes. */
export interface AsyncAttestationSigner {
  sign(data: Uint8Array): Promise<string>;
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

function buildAttestationDoc(
  rows: readonly AuditRow[],
  opts: { subject?: string; toolVersion: string; generatedAt: string },
): AuditAttestation {
  return {
    tool: 'gulley-audit-verify',
    toolVersion: opts.toolVersion,
    generatedAt: opts.generatedAt,
    ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
    chain: verifyAuditChain(rows),
  };
}

/**
 * Async twin of {@link attestAuditChain} for asymmetric (KMS) signing. The signature
 * is over the SAME canonical attestation bytes, so an auditor verifies it offline with
 * only the published public key ({@link verifyAttestationWithPublicKey}) — no shared
 * secret. `algorithm` must be an asymmetric one (HMAC uses the sync path).
 */
export async function attestAuditChainAsync(
  rows: readonly AuditRow[],
  opts: {
    signer: AsyncAttestationSigner;
    algorithm: AttestationAlgorithm;
    subject?: string;
    toolVersion: string;
    generatedAt: string;
  },
): Promise<SignedAttestation> {
  if (opts.algorithm === 'HMAC-SHA256') {
    throw new Error(
      'attestAuditChainAsync is for asymmetric signing; use attestAuditChain for HMAC',
    );
  }
  const attestation = buildAttestationDoc(rows, opts);
  const signature = await opts.signer.sign(Buffer.from(canonicalize(attestation)));
  return { attestation, algorithm: opts.algorithm, signature };
}

/**
 * Verify an asymmetric (KMS-signed) attestation OFFLINE with only the SPKI public-key
 * PEM. Fail-closed: an HMAC doc (wrong verifier), an unknown algorithm, or any bad
 * key/signature returns false rather than throwing.
 */
export function verifyAttestationWithPublicKey(
  doc: SignedAttestation,
  publicKeyPem: string,
): boolean {
  const hash = ASYM_HASH[doc.algorithm];
  if (!hash) return false; // HMAC-SHA256 or unknown — not an asymmetric doc
  try {
    return nodeVerify(
      hash,
      Buffer.from(canonicalize(doc.attestation)),
      createPublicKey(publicKeyPem),
      Buffer.from(doc.signature, 'base64'),
    );
  } catch {
    return false;
  }
}
