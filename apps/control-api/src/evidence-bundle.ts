import type { AuditRow, SignedAttestation } from '@gulley/pipeline';
import {
  verifyAttestation,
  verifyAttestationWithPublicKey,
  verifyAuditChain,
} from '@gulley/pipeline';
import { reviveRows } from './audit-verify';

/**
 * Evidence bundle — a single, downloadable, INDEPENDENTLY-verifiable compliance
 * artifact. It composes everything an auditor needs to prove the audit log is intact
 * and un-tampered, WITHOUT trusting Gulley at verification time:
 *
 *   - the full ordered audit rows (non-PII metadata; createdAt as ISO strings), so the
 *     auditor re-walks the hash chain themselves;
 *   - the signed auditor attestation (HMAC or asymmetric) pinning the chain's
 *     first/last hash + count + time range;
 *   - the audit-export public key (when asymmetric) as a convenience hint — but the
 *     verifier is given the trusted key OUT-OF-BAND (from /.well-known/gulley-audit-key
 *     or a prior trust exchange), never trusting the embedded copy;
 *   - a WORM mirror status snapshot (immutable-storage evidence), when configured.
 *
 * Verification (below) is a pure function so an auditor can run it offline. The bundle
 * needs no signature of its own: tampering with the rows is caught because they must
 * re-walk to the hashes in the SIGNED attestation.
 */
export interface SerializedAuditRow {
  seq: number;
  orgId: string | null;
  actor: string;
  action: string;
  target: string | null;
  payload: Record<string, unknown>;
  prevHash: string | null;
  rowHash: string;
  createdAt: string;
}

export interface WormEvidence {
  verified: boolean;
  rows: number;
  lastSeq: number;
  reason?: string;
}

export interface EvidenceBundle {
  tool: 'gulley-evidence-bundle';
  toolVersion: string;
  generatedAt: string;
  subject?: string;
  attestation: SignedAttestation;
  rows: SerializedAuditRow[];
  /** Public key hint (asymmetric only). NOT trusted by the verifier — fetch the real
   *  key out-of-band. */
  publicKey?: { alg: string; pem: string };
  worm?: WormEvidence;
}

function serializeRow(r: AuditRow): SerializedAuditRow {
  return {
    seq: r.seq,
    orgId: r.orgId ?? null,
    actor: r.actor,
    action: r.action,
    target: r.target ?? null,
    payload: r.payload ?? {},
    prevHash: r.prevHash,
    rowHash: r.rowHash,
    createdAt: r.createdAt.toISOString(),
  };
}

export interface BuildBundleInput {
  rows: readonly AuditRow[];
  attestation: SignedAttestation;
  toolVersion: string;
  generatedAt: string;
  subject?: string;
  publicKey?: { alg: string; pem: string };
  worm?: WormEvidence;
}

export function buildEvidenceBundle(input: BuildBundleInput): EvidenceBundle {
  return {
    tool: 'gulley-evidence-bundle',
    toolVersion: input.toolVersion,
    generatedAt: input.generatedAt,
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    attestation: input.attestation,
    rows: input.rows.map(serializeRow),
    ...(input.publicKey ? { publicKey: input.publicKey } : {}),
    ...(input.worm ? { worm: input.worm } : {}),
  };
}

export interface EvidenceVerifyReport {
  ok: boolean;
  count: number;
  checks: {
    /** The embedded rows independently re-walk to an intact hash chain. */
    chainIntact: boolean;
    /** That independent walk matches the SIGNED attestation (hashes + count). */
    matchesAttestation: boolean;
    /** The attestation signature is authentic under the OUT-OF-BAND key. */
    attestationSigned: boolean;
  };
  reason?: string;
}

/**
 * Verify an evidence bundle OFFLINE. The trusted verification key is passed in — a
 * `publicKeyPem` for an asymmetric attestation, or an `hmacKey` for the shared-secret
 * one — and is used INSTEAD of the bundle's embedded public-key hint. Fail-closed: any
 * failed check yields ok:false with a reason.
 */
export function verifyEvidenceBundle(
  bundle: EvidenceBundle,
  opts: { publicKeyPem?: string; hmacKey?: string },
): EvidenceVerifyReport {
  let rows: AuditRow[];
  try {
    rows = reviveRows(bundle.rows);
  } catch (err) {
    return {
      ok: false,
      count: 0,
      checks: { chainIntact: false, matchesAttestation: false, attestationSigned: false },
      reason: `unreadable rows: ${(err as Error).message}`,
    };
  }

  const chain = verifyAuditChain(rows);
  const chainIntact = chain.verified;

  const attChain = bundle.attestation.attestation.chain;
  const matchesAttestation =
    chainIntact &&
    attChain.verified &&
    chain.count === attChain.count &&
    chain.firstHash === attChain.firstHash &&
    chain.lastHash === attChain.lastHash;

  let attestationSigned = false;
  if (opts.publicKeyPem) {
    attestationSigned = verifyAttestationWithPublicKey(bundle.attestation, opts.publicKeyPem);
  } else if (opts.hmacKey) {
    attestationSigned = verifyAttestation(bundle.attestation, opts.hmacKey);
  }

  const checks = { chainIntact, matchesAttestation, attestationSigned };
  const ok = chainIntact && matchesAttestation && attestationSigned;
  return {
    ok,
    count: chain.count,
    checks,
    ...(ok
      ? {}
      : {
          reason: !chainIntact
            ? `chain broken at seq ${chain.brokenAtSeq}`
            : !matchesAttestation
              ? 'rows do not match the signed attestation'
              : 'attestation signature invalid (or no verification key supplied)',
        }),
  };
}
