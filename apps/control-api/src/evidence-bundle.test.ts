import { createHash, randomBytes } from 'node:crypto';
import { LocalKeypairSigner } from '@gulley/crypto';
import {
  type AuditRow,
  attestAuditChain,
  attestAuditChainAsync,
  InMemoryAuditSink,
  type SignedAttestation,
} from '@gulley/pipeline';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { createInMemoryControlContext } from './context';
import { buildEvidenceBundle, type EvidenceBundle, verifyEvidenceBundle } from './evidence-bundle';
import { buildServer } from './server';

const HMAC = 'evidence-hmac-key-16+chars!!!!!!';

async function seededRows(n: number): Promise<AuditRow[]> {
  let t = 1_700_000_000_000;
  const sink = new InMemoryAuditSink(() => new Date((t += 1000)));
  for (let i = 0; i < n; i++) {
    await sink.append({ orgId: 'org_1', actor: 'admin', action: `act.${i}`, target: `t${i}` });
  }
  return sink.rows;
}

const AT = { toolVersion: '9.9.9', generatedAt: '2026-01-01T00:00:00.000Z' };

describe('buildEvidenceBundle / verifyEvidenceBundle', () => {
  it('verifies an HMAC-signed bundle with the shared key', async () => {
    const rows = await seededRows(4);
    const attestation = attestAuditChain(rows, { key: HMAC, ...AT });
    const bundle = buildEvidenceBundle({ rows, attestation, ...AT });

    const report = verifyEvidenceBundle(bundle, { hmacKey: HMAC });
    expect(report.ok).toBe(true);
    expect(report.count).toBe(4);
    expect(report.checks).toEqual({
      chainIntact: true,
      matchesAttestation: true,
      attestationSigned: true,
    });
    // Wrong key → signature check fails.
    expect(verifyEvidenceBundle(bundle, { hmacKey: 'the-wrong-key-1234567890' }).ok).toBe(false);
    // No key at all → cannot attest.
    expect(verifyEvidenceBundle(bundle, {}).checks.attestationSigned).toBe(false);
  });

  it('verifies an asymmetric bundle offline with only the public key (survives JSON round-trip)', async () => {
    const signer = new LocalKeypairSigner();
    const rows = await seededRows(5);
    const attestation = await attestAuditChainAsync(rows, {
      signer,
      algorithm: signer.algorithm,
      ...AT,
    });
    const pem = await signer.publicKeyPem();
    const bundle = buildEvidenceBundle({
      rows,
      attestation,
      publicKey: { alg: signer.algorithm, pem },
      worm: { verified: true, rows: 5, lastSeq: 5 },
      ...AT,
    });

    // Simulate a download: serialize then re-parse.
    const roundTripped = JSON.parse(JSON.stringify(bundle)) as EvidenceBundle;
    const report = verifyEvidenceBundle(roundTripped, { publicKeyPem: pem });
    expect(report.ok).toBe(true);
    expect(report.count).toBe(5);
  });

  it('fails closed when a row is tampered after signing', async () => {
    const rows = await seededRows(3);
    const attestation = attestAuditChain(rows, { key: HMAC, ...AT });
    const bundle = buildEvidenceBundle({ rows, attestation, ...AT });
    // Tamper a payload in the serialized rows (the hash chain no longer re-walks).
    bundle.rows[1]!.payload = { hacked: true };
    const report = verifyEvidenceBundle(bundle, { hmacKey: HMAC });
    expect(report.ok).toBe(false);
    expect(report.checks.chainIntact).toBe(false);
    expect(report.reason).toContain('chain broken');
  });

  it('fails closed when the attestation claims are altered after signing', async () => {
    const rows = await seededRows(3);
    const attestation = attestAuditChain(rows, { key: HMAC, ...AT });
    const bundle = buildEvidenceBundle({ rows, attestation, ...AT });
    // Forge a smaller count in the (signed) attestation — signature no longer matches.
    bundle.attestation.attestation.chain.count = 1;
    const report = verifyEvidenceBundle(bundle, { hmacKey: HMAC });
    expect(report.ok).toBe(false);
    expect(report.checks.attestationSigned).toBe(false);
  });
});

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

describe('GET /audit/evidence-bundle', () => {
  function build(asymmetric: boolean): { app: FastifyInstance; gadm: string } {
    const gadm = `gadm_${randomBytes(24).toString('base64url')}`;
    const auditSigner = asymmetric ? new LocalKeypairSigner() : undefined;
    const ctx = createInMemoryControlContext({
      pepper: 'evidence-pepper-16chars!!!!!!!!!',
      bootstrapEnabled: true,
      bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
      sessionSecrets: ['evidence-session-secret-32bytes-long-x'],
      maxSessionTtlMs: 900_000,
      ...(auditSigner ? { auditSigner } : { attestationKey: HMAC }),
    });
    return {
      app: buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx),
      gadm,
    };
  }

  it('501s when no signer is configured', async () => {
    const gadm = `gadm_${randomBytes(24).toString('base64url')}`;
    const ctx = createInMemoryControlContext({
      pepper: 'evidence-pepper-16chars!!!!!!!!!',
      bootstrapEnabled: true,
      bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
      sessionSecrets: ['evidence-session-secret-32bytes-long-x'],
      maxSessionTtlMs: 900_000,
    });
    app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
    const res = await app.inject({
      method: 'GET',
      url: '/audit/evidence-bundle',
      headers: { authorization: `Bearer ${gadm}` },
    });
    expect(res.statusCode).toBe(501);
  });

  it('returns a downloadable bundle an auditor verifies offline (asymmetric)', async () => {
    const built = build(true);
    app = built.app;
    const h = { authorization: `Bearer ${built.gadm}` };
    await app.inject({
      method: 'POST',
      url: '/orgs',
      headers: { ...h, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Acme' }),
    });

    const res = await app.inject({ method: 'GET', url: '/audit/evidence-bundle', headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    const bundle = res.json() as EvidenceBundle;
    expect(bundle.tool).toBe('gulley-evidence-bundle');
    expect(bundle.rows.length).toBeGreaterThan(0);
    expect(bundle.publicKey?.alg).toBe('ECDSA_SHA_256');

    // Fetch the trusted key out-of-band and verify the bundle offline.
    const keyRes = await app.inject({ method: 'GET', url: '/.well-known/gulley-audit-key' });
    const { publicKey } = keyRes.json() as { publicKey: string };
    expect(verifyEvidenceBundle(bundle, { publicKeyPem: publicKey }).ok).toBe(true);
  });

  it('returns an HMAC bundle an auditor verifies with the shared key', async () => {
    const built = build(false);
    app = built.app;
    const h = { authorization: `Bearer ${built.gadm}` };
    await app.inject({
      method: 'POST',
      url: '/orgs',
      headers: { ...h, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Globex' }),
    });
    const res = await app.inject({ method: 'GET', url: '/audit/evidence-bundle', headers: h });
    expect(res.statusCode).toBe(200);
    const bundle = res.json() as EvidenceBundle;
    expect(bundle.publicKey).toBeUndefined();
    expect((bundle.attestation as SignedAttestation).algorithm).toBe('HMAC-SHA256');
    expect(verifyEvidenceBundle(bundle, { hmacKey: HMAC }).ok).toBe(true);
  });
});
