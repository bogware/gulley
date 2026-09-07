import { createHash, randomBytes } from 'node:crypto';
import { InMemoryHmacSigner, LocalKeypairSigner, verifyWithPublicKey } from '@gulley/crypto';
import { InMemoryAuditMirror } from '@gulley/worm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { createInMemoryControlContext } from './context';
import { buildServer } from './server';

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

function build(opts: { worm?: boolean; asymmetric?: boolean } = {}): {
  app: FastifyInstance;
  gadm: string;
  mirror: InMemoryAuditMirror;
} {
  const gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  const mirror = new InMemoryAuditMirror();
  // Asymmetric (KMS twin) or shared-secret HMAC batch signer.
  const auditSigner = opts.asymmetric ? new LocalKeypairSigner() : undefined;
  const signer = auditSigner ?? new InMemoryHmacSigner();
  const ctx = createInMemoryControlContext({
    pepper: 'worm-routes-pepper-16chars!!!!!!',
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: ['worm-routes-session-secret-32bytes-long'],
    maxSessionTtlMs: 900_000,
    ...(auditSigner ? { auditSigner } : {}),
    ...(opts.worm ? { worm: { mirror, signer, verifier: signer } } : {}),
  });
  return {
    app: buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx),
    gadm,
    mirror,
  };
}

/** Generate some audited writes (each POST /orgs appends to the hash chain). */
async function seedAudit(a: FastifyInstance, gadm: string, name: string): Promise<void> {
  const res = await a.inject({
    method: 'POST',
    url: '/orgs',
    headers: { authorization: `Bearer ${gadm}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ name }),
  });
  expect(res.statusCode).toBe(201);
}

describe('WORM routes (not configured)', () => {
  it('501s on status / ship / verify when WORM is off', async () => {
    const built = build();
    app = built.app;
    const h = { authorization: `Bearer ${built.gadm}` };
    for (const [method, url] of [
      ['GET', '/audit/worm/status'],
      ['POST', '/audit/worm/ship'],
      ['GET', '/audit/worm/verify'],
    ] as const) {
      const res = await app.inject({ method, url, headers: h });
      expect(res.statusCode, `${method} ${url}`).toBe(501);
    }
  });

  it('404s on the audit public key when no asymmetric signer is configured', async () => {
    const built = build({ worm: true }); // HMAC signer → no public key
    app = built.app;
    const res = await app.inject({ method: 'GET', url: '/.well-known/gulley-audit-key' });
    expect(res.statusCode).toBe(404);
  });
});

describe('WORM routes (configured)', () => {
  it('401s without an admin token', async () => {
    const built = build({ worm: true });
    app = built.app;
    const res = await app.inject({ method: 'GET', url: '/audit/worm/status' });
    expect(res.statusCode).toBe(401);
  });

  it('ships the durable chain, verifies it, and is idempotent', async () => {
    const built = build({ worm: true });
    app = built.app;
    const h = { authorization: `Bearer ${built.gadm}` };

    await seedAudit(app, built.gadm, 'Acme');
    await seedAudit(app, built.gadm, 'Globex');

    // status before shipping: nothing mirrored yet.
    const s0 = await app.inject({ method: 'GET', url: '/audit/worm/status', headers: h });
    expect(s0.statusCode).toBe(200);
    expect(s0.json()).toMatchObject({ enabled: true, lastSeq: 0 });

    // ship.
    const shipped = await app.inject({ method: 'POST', url: '/audit/worm/ship', headers: h });
    expect(shipped.statusCode).toBe(200);
    const sr = shipped.json() as { shipped: number; lastSeq: number };
    expect(sr.shipped).toBeGreaterThan(0);
    expect(sr.lastSeq).toBe(sr.shipped);
    expect(await built.mirror.list()).not.toHaveLength(0);

    // verify the mirrored chain independently.
    const verified = await app.inject({ method: 'GET', url: '/audit/worm/verify', headers: h });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ ok: true, rows: sr.shipped, lastSeq: sr.lastSeq });

    // status now reflects the shipped watermark.
    const s1 = await app.inject({ method: 'GET', url: '/audit/worm/status', headers: h });
    expect(s1.json()).toMatchObject({ enabled: true, lastSeq: sr.lastSeq });

    // idempotent re-ship: nothing new.
    const again = await app.inject({ method: 'POST', url: '/audit/worm/ship', headers: h });
    expect(again.json()).toMatchObject({ shipped: 0, lastSeq: sr.lastSeq });
  });

  it('ships only newly-appended rows on the next tick', async () => {
    const built = build({ worm: true });
    app = built.app;
    const h = { authorization: `Bearer ${built.gadm}` };

    await seedAudit(app, built.gadm, 'First');
    const first = (
      await app.inject({ method: 'POST', url: '/audit/worm/ship', headers: h })
    ).json() as { shipped: number; lastSeq: number };
    expect(first.shipped).toBeGreaterThan(0);

    await seedAudit(app, built.gadm, 'Second');
    const second = (
      await app.inject({ method: 'POST', url: '/audit/worm/ship', headers: h })
    ).json() as { shipped: number; lastSeq: number };
    expect(second.shipped).toBeGreaterThan(0);
    expect(second.lastSeq).toBeGreaterThan(first.lastSeq);

    const verified = await app.inject({ method: 'GET', url: '/audit/worm/verify', headers: h });
    expect(verified.json()).toMatchObject({ ok: true, lastSeq: second.lastSeq });
  });
});

describe('WORM routes (asymmetric audit signer)', () => {
  it('ships, publishes the public key, and batches verify offline with only that key', async () => {
    const built = build({ worm: true, asymmetric: true });
    app = built.app;
    const h = { authorization: `Bearer ${built.gadm}` };

    await seedAudit(app, built.gadm, 'Acme');
    await seedAudit(app, built.gadm, 'Globex');

    const shipped = (
      await app.inject({ method: 'POST', url: '/audit/worm/ship', headers: h })
    ).json() as { shipped: number };
    expect(shipped.shipped).toBeGreaterThan(0);

    // In-process verify (local check against the same key) passes.
    const verified = await app.inject({ method: 'GET', url: '/audit/worm/verify', headers: h });
    expect(verified.json()).toMatchObject({ ok: true });

    // The public key is served UNAUTHENTICATED (an auditor fetches it out-of-band).
    const keyRes = await app.inject({ method: 'GET', url: '/.well-known/gulley-audit-key' });
    expect(keyRes.statusCode).toBe(200);
    const { alg, publicKey } = keyRes.json() as { alg: string; publicKey: string };
    expect(alg).toBe('ECDSA_SHA_256');
    expect(publicKey).toContain('BEGIN PUBLIC KEY');

    // An external auditor verifies every mirrored batch offline with ONLY that key.
    const refs = await built.mirror.list();
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const batch = await built.mirror.get(ref);
      expect(verifyWithPublicKey(publicKey, Buffer.from(batch.batchHash), batch.signature)).toBe(
        true,
      );
    }
  });
});
