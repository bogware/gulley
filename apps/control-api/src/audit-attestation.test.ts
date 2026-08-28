import { createHash, randomBytes } from 'node:crypto';
import { InMemoryAuditSink, type SignedAttestation, verifyAttestation } from '@gulley/pipeline';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAttestation, reviveRows } from './audit-verify';
import { loadConfig } from './config';
import { createInMemoryControlContext } from './context';
import { buildServer } from './server';

const KEY = 'attestation-hmac-key-16+chars!!!';
let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

function build(attestationKey?: string): { app: FastifyInstance; gadm: string } {
  const gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  const ctx = createInMemoryControlContext({
    pepper: 'attestation-pepper-16chars!!!!!!',
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: ['attestation-session-secret-32bytes-long'],
    maxSessionTtlMs: 900_000,
    ...(attestationKey !== undefined ? { attestationKey } : {}),
  });
  return { app: buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx), gadm };
}

describe('GET /audit/attestation', () => {
  it('501s when no attestation key is configured', async () => {
    const built = build();
    app = built.app;
    const res = await app.inject({
      method: 'GET',
      url: '/audit/attestation',
      headers: { authorization: `Bearer ${built.gadm}` },
    });
    expect(res.statusCode).toBe(501);
  });

  it('returns a signed, independently-verifiable attestation over the chain', async () => {
    const built = build(KEY);
    app = built.app;
    // Generate some audited writes.
    await app.inject({
      method: 'POST',
      url: '/orgs',
      headers: { authorization: `Bearer ${built.gadm}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Acme' }),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/audit/attestation',
      headers: { authorization: `Bearer ${built.gadm}` },
    });
    expect(res.statusCode).toBe(200);
    const signed = res.json() as SignedAttestation;
    expect(signed.attestation.chain.verified).toBe(true);
    expect(signed.attestation.chain.count).toBeGreaterThan(0);
    expect(signed.attestation.tool).toBe('gulley-audit-verify');
    // An auditor holding the same key verifies it independently.
    expect(verifyAttestation(signed, KEY)).toBe(true);
    expect(verifyAttestation(signed, 'wrong-key')).toBe(false);
  });

  it('401s without an admin token', async () => {
    const built = build(KEY);
    app = built.app;
    const res = await app.inject({ method: 'GET', url: '/audit/attestation' });
    expect(res.statusCode).toBe(401);
  });
});

describe('audit-verify CLI helpers', () => {
  it('reviveRows round-trips an exported chain and buildAttestation verifies it', async () => {
    const sink = new InMemoryAuditSink();
    await sink.append({ actor: 'a', action: 'x' });
    await sink.append({ actor: 'a', action: 'y' });
    // Simulate a JSON export (createdAt becomes an ISO string) and re-import.
    const exported = JSON.parse(JSON.stringify(sink.rows));
    const rows = reviveRows(exported);
    const signed = buildAttestation(rows, { key: KEY, generatedAt: '2026-01-01T00:00:00.000Z' });
    expect(signed.attestation.chain.verified).toBe(true);
    expect(verifyAttestation(signed, KEY)).toBe(true);
  });

  it('reviveRows also accepts a { rows: [...] } wrapper and rejects garbage', () => {
    expect(reviveRows({ rows: [] })).toEqual([]);
    expect(() => reviveRows(42)).toThrow();
  });
});
