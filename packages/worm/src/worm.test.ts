import { InMemoryHmacSigner, LocalKeypairSigner, verifyWithPublicKey } from '@gulley/crypto';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  batchHash,
  buildBatch,
  InMemoryAuditMirror,
  type MirroredRow,
  verifyMirrorChain,
} from './batch';

/** Build a chained run of `n` mirrored rows (rowHash = H(prevHash‖seq)). */
function chain(n: number): MirroredRow[] {
  const rows: MirroredRow[] = [];
  let prevHash: string | null = null;
  for (let seq = 1; seq <= n; seq++) {
    const rowHash: string = createHash('sha256')
      .update(`${prevHash ?? ''}:${seq}`)
      .digest('hex');
    rows.push({
      seq,
      orgId: 'o1',
      actor: 'admin',
      action: 'proxy.request',
      target: 'anthropic',
      payload: { model: 'haiku' },
      prevHash,
      rowHash,
      createdAt: `2026-08-13T00:00:${String(seq).padStart(2, '0')}.000Z`,
    });
    prevHash = rowHash;
  }
  return rows;
}

async function shipWindows(rows: MirroredRow[], windowRows: number, signer: InMemoryHmacSigner) {
  const mirror = new InMemoryAuditMirror();
  for (let i = 0; i < rows.length; i += windowRows) {
    await mirror.put(await buildBatch(rows.slice(i, i + windowRows), signer));
  }
  return mirror;
}

describe('WORM mirror chain', () => {
  it('verifies a signed, multi-batch chain', async () => {
    const signer = new InMemoryHmacSigner();
    const mirror = await shipWindows(chain(7), 5, signer); // 2 batches (5 + 2)
    const r = await verifyMirrorChain(mirror, signer);
    expect(r.ok).toBe(true);
    expect(r.rows).toBe(7);
    expect(r.lastSeq).toBe(7);
  });

  it('put is idempotent by seq window (crash-resume re-ships the same key)', async () => {
    const signer = new InMemoryHmacSigner();
    const rows = chain(5);
    const mirror = new InMemoryAuditMirror();
    const a = await mirror.put(await buildBatch(rows, signer));
    const b = await mirror.put(await buildBatch(rows, signer));
    expect(a.key).toBe(b.key);
    expect((await mirror.list()).length).toBe(1);
  });

  it('detects a broken chain link', async () => {
    const signer = new InMemoryHmacSigner();
    const rows = chain(4);
    rows[2]!.prevHash = 'deadbeef'; // snip the chain
    const mirror = new InMemoryAuditMirror();
    await mirror.put(await buildBatch(rows, signer));
    const r = await verifyMirrorChain(mirror, signer);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('chain break');
  });

  it('detects a forged batch (wrong signer)', async () => {
    const signer = new InMemoryHmacSigner();
    const attacker = new InMemoryHmacSigner();
    const mirror = await shipWindows(chain(3), 5, attacker);
    expect((await verifyMirrorChain(mirror, signer)).ok).toBe(false);
  });

  it('supports an asymmetric signer — auditor verifies batches with only the public key', async () => {
    const signer = new LocalKeypairSigner();
    const mirror = new InMemoryAuditMirror();
    const rows = chain(6);
    for (let i = 0; i < rows.length; i += 4) {
      await mirror.put(await buildBatch(rows.slice(i, i + 4), signer));
    }
    // In-process verify (the shipper's own /verify) passes.
    expect((await verifyMirrorChain(mirror, signer)).ok).toBe(true);

    // An external auditor with ONLY the published public key verifies every batch
    // signature offline — no KMS, no shared secret.
    const pem = await signer.publicKeyPem();
    for (const ref of await mirror.list()) {
      const batch = await mirror.get(ref);
      expect(batchHash(batch.rows)).toBe(batch.batchHash); // hash recomputes
      expect(verifyWithPublicKey(pem, Buffer.from(batch.batchHash), batch.signature)).toBe(true);
    }
  });
});
