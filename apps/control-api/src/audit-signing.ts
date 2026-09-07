import { GULLEY_VERSION } from '@gulley/core';
import {
  type AuditRow,
  attestAuditChain,
  attestAuditChainAsync,
  type SignedAttestation,
} from '@gulley/pipeline';
import type { ControlContext } from './context';

/**
 * Sign an auditor attestation with the context's configured signer — the asymmetric
 * (KMS) audit signer when present, else the shared-secret HMAC key. Returns undefined
 * when neither is configured. Shared by the attestation, evidence-bundle, and
 * anchoring paths so they always sign identically.
 */
export async function signCtxAttestation(
  ctx: Pick<ControlContext, 'auditSigner' | 'attestationKey' | 'attestationSubject'>,
  rows: readonly AuditRow[],
  generatedAt: string,
): Promise<SignedAttestation | undefined> {
  const common = {
    toolVersion: GULLEY_VERSION,
    generatedAt,
    ...(ctx.attestationSubject !== undefined ? { subject: ctx.attestationSubject } : {}),
  };
  if (ctx.auditSigner) {
    return attestAuditChainAsync(rows, {
      signer: ctx.auditSigner,
      algorithm: ctx.auditSigner.algorithm,
      ...common,
    });
  }
  if (ctx.attestationKey) {
    return attestAuditChain(rows, { key: ctx.attestationKey, ...common });
  }
  return undefined;
}
