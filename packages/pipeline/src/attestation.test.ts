import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  attestAuditChain,
  attestAuditChainAsync,
  signAttestation,
  verifyAttestation,
  verifyAttestationWithPublicKey,
  verifyAuditChain,
} from './attestation';
import { InMemoryAuditSink } from './memory';

async function seededSink(n: number): Promise<InMemoryAuditSink> {
  let t = 1_700_000_000_000;
  const sink = new InMemoryAuditSink(() => new Date((t += 1000)));
  for (let i = 0; i < n; i++) {
    await sink.append({ orgId: 'org_1', actor: 'admin', action: `act.${i}`, target: `t${i}` });
  }
  return sink;
}

describe('verifyAuditChain', () => {
  it('reports an intact chain with hashes and time range', async () => {
    const sink = await seededSink(3);
    const r = verifyAuditChain(sink.rows);
    expect(r.verified).toBe(true);
    expect(r.count).toBe(3);
    expect(r.firstSeq).toBe(1);
    expect(r.lastSeq).toBe(3);
    expect(r.firstHash).toBe(sink.rows[0]!.rowHash);
    expect(r.lastHash).toBe(sink.rows[2]!.rowHash);
    expect(r.firstAt).toBe(sink.rows[0]!.createdAt.toISOString());
  });

  it('is verified/empty for an empty chain', () => {
    expect(verifyAuditChain([])).toMatchObject({ verified: true, count: 0, firstHash: null });
  });

  it('detects a tampered payload at the broken seq', async () => {
    const sink = await seededSink(3);
    sink.rows[1]!.payload = { hacked: true };
    const r = verifyAuditChain(sink.rows);
    expect(r.verified).toBe(false);
    expect(r.brokenAtSeq).toBe(2);
  });

  it('detects a removed/renumbered row', async () => {
    const sink = await seededSink(3);
    sink.rows.splice(1, 1); // drop seq 2 → seq jumps 1→3, prevHash mismatch
    expect(verifyAuditChain(sink.rows).verified).toBe(false);
  });
});

describe('attestation signing', () => {
  const KEY = 'compliance-hmac-key-please-change';

  it('round-trips a signed attestation', async () => {
    const sink = await seededSink(4);
    const signed = attestAuditChain(sink.rows, {
      key: KEY,
      toolVersion: '9.9.9',
      generatedAt: '2026-01-01T00:00:00.000Z',
      subject: 'prod-us-east',
    });
    expect(signed.algorithm).toBe('HMAC-SHA256');
    expect(signed.attestation.tool).toBe('gulley-audit-verify');
    expect(signed.attestation.subject).toBe('prod-us-east');
    expect(signed.attestation.chain.verified).toBe(true);
    expect(verifyAttestation(signed, KEY)).toBe(true);
  });

  it('fails verification under the wrong key', async () => {
    const sink = await seededSink(2);
    const signed = signAttestation(
      {
        tool: 'gulley-audit-verify',
        toolVersion: '1.0.0',
        generatedAt: '2026-01-01T00:00:00.000Z',
        chain: verifyAuditChain(sink.rows),
      },
      KEY,
    );
    expect(verifyAttestation(signed, 'a-different-key')).toBe(false);
  });

  it('fails verification if the attestation body is altered after signing', async () => {
    const sink = await seededSink(2);
    const signed = attestAuditChain(sink.rows, {
      key: KEY,
      toolVersion: '1.0.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    signed.attestation.chain.verified = false; // forge a "broken" claim
    expect(verifyAttestation(signed, KEY)).toBe(false);
  });
});

describe('asymmetric attestation (KMS-signable, offline-verifiable)', () => {
  // A structural async signer backed by a local EC key stands in for KmsSigner.
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const signer = {
    sign: (data: Uint8Array): Promise<string> =>
      Promise.resolve(nodeSign('sha256', Buffer.from(data), privateKey).toString('base64')),
  };

  it('signs asynchronously and verifies offline with only the public key', async () => {
    const sink = await seededSink(4);
    const signed = await attestAuditChainAsync(sink.rows, {
      signer,
      algorithm: 'ECDSA_SHA_256',
      toolVersion: '9.9.9',
      generatedAt: '2026-01-01T00:00:00.000Z',
      subject: 'prod-eu',
    });
    expect(signed.algorithm).toBe('ECDSA_SHA_256');
    expect(signed.attestation.subject).toBe('prod-eu');
    expect(signed.attestation.chain.verified).toBe(true);
    expect(verifyAttestationWithPublicKey(signed, pem)).toBe(true);
  });

  it('fails offline verification if the body is altered after signing', async () => {
    const sink = await seededSink(2);
    const signed = await attestAuditChainAsync(sink.rows, {
      signer,
      algorithm: 'ECDSA_SHA_256',
      toolVersion: '1.0.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    signed.attestation.chain.count = 999;
    expect(verifyAttestationWithPublicKey(signed, pem)).toBe(false);
  });

  it('rejects the HMAC path and refuses HMAC docs / bad keys', async () => {
    await expect(
      attestAuditChainAsync([], {
        signer,
        algorithm: 'HMAC-SHA256',
        toolVersion: '1',
        generatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow();
    const hmac = attestAuditChain([], {
      key: 'compliance-hmac-key-please-change',
      toolVersion: '1',
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(verifyAttestationWithPublicKey(hmac, pem)).toBe(false); // wrong verifier
  });
});
