import { InMemoryHmacSigner } from '@gulley/crypto';
import { type AuditRow, InMemoryAuditSink } from '@gulley/pipeline';
import { InMemoryAuditMirror } from '@gulley/worm';
import { describe, expect, it } from 'vitest';
import { toMirroredRow, WormShipper } from './worm-shipper';

/** A durable-chain stand-in: the InMemoryAuditSink produces a real, gapless
 *  hash-chain (seq from 1, prevHash null first), exactly like readAuditRows(db). */
function chain(): { sink: InMemoryAuditSink; readRows: () => Promise<AuditRow[]> } {
  const sink = new InMemoryAuditSink(() => new Date('2026-01-01T00:00:00.000Z'));
  return { sink, readRows: async () => sink.rows };
}

async function append(sink: InMemoryAuditSink, n: number, offset = 0): Promise<void> {
  for (let i = 0; i < n; i++) await sink.append({ actor: 'admin', action: `act.${offset + i}` });
}

describe('toMirroredRow', () => {
  it('converts createdAt to an ISO string and null-coalesces optionals', () => {
    const row: AuditRow = {
      seq: 7,
      actor: 'admin',
      action: 'org.create',
      prevHash: null,
      rowHash: 'abc',
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
    };
    expect(toMirroredRow(row)).toEqual({
      seq: 7,
      orgId: null,
      actor: 'admin',
      action: 'org.create',
      target: null,
      payload: {},
      prevHash: null,
      rowHash: 'abc',
      createdAt: '2026-01-02T03:04:05.000Z',
    });
  });
});

describe('WormShipper', () => {
  it('ships the complete chain and the mirror verifies end-to-end', async () => {
    const { sink, readRows } = chain();
    await append(sink, 3);
    const mirror = new InMemoryAuditMirror();
    const signer = new InMemoryHmacSigner();
    const shipper = new WormShipper({ mirror, signer, verifier: signer, readRows });

    const res = await shipper.ship();
    expect(res).toEqual({ shipped: 3, lastSeq: 3 });
    expect(shipper.lastSeq).toBe(3);

    const v = await shipper.verify();
    expect(v).toEqual({ ok: true, rows: 3, lastSeq: 3 });
    expect(await mirror.list()).toHaveLength(1);
  });

  it('is idempotent — a second ship with no new rows ships nothing', async () => {
    const { sink, readRows } = chain();
    await append(sink, 2);
    const mirror = new InMemoryAuditMirror();
    const signer = new InMemoryHmacSigner();
    const shipper = new WormShipper({ mirror, signer, verifier: signer, readRows });

    expect((await shipper.ship()).shipped).toBe(2);
    expect(await shipper.ship()).toEqual({ shipped: 0, lastSeq: 2 });
    expect(await mirror.list()).toHaveLength(1);
  });

  it('ships only rows appended since the last ship (incremental, links across batches)', async () => {
    const { sink, readRows } = chain();
    await append(sink, 2);
    const mirror = new InMemoryAuditMirror();
    const signer = new InMemoryHmacSigner();
    const shipper = new WormShipper({ mirror, signer, verifier: signer, readRows });

    expect((await shipper.ship()).shipped).toBe(2);
    await append(sink, 3, 2);
    const res = await shipper.ship();
    expect(res).toEqual({ shipped: 3, lastSeq: 5 });

    // The cross-batch rowHash links + gapless seq still verify.
    expect(await shipper.verify()).toEqual({ ok: true, rows: 5, lastSeq: 5 });
    expect(await mirror.list()).toHaveLength(2);
  });

  it('splits into contiguous objects of at most batchMax rows', async () => {
    const { sink, readRows } = chain();
    await append(sink, 5);
    const mirror = new InMemoryAuditMirror();
    const signer = new InMemoryHmacSigner();
    const shipper = new WormShipper({ mirror, signer, verifier: signer, readRows, batchMax: 2 });

    const res = await shipper.ship();
    expect(res).toEqual({ shipped: 5, lastSeq: 5 });
    // ceil(5/2) = 3 objects: [1,2] [3,4] [5].
    expect(await mirror.list()).toHaveLength(3);
    expect(await shipper.verify()).toEqual({ ok: true, rows: 5, lastSeq: 5 });
  });

  it('resumes from an existing WORM record without re-shipping', async () => {
    const { sink, readRows } = chain();
    await append(sink, 4);
    const mirror = new InMemoryAuditMirror();
    const signer = new InMemoryHmacSigner();

    // First process ships everything.
    await new WormShipper({ mirror, signer, verifier: signer, readRows }).ship();
    await append(sink, 2, 4);

    // A fresh shipper (restart) over the SAME mirror resolves last-shipped from the
    // record and only ships the new rows.
    const resumed = new WormShipper({ mirror, signer, verifier: signer, readRows });
    const res = await resumed.ship();
    expect(res).toEqual({ shipped: 2, lastSeq: 6 });
    expect(await resumed.verify()).toEqual({ ok: true, rows: 6, lastSeq: 6 });
  });

  it('single-flights concurrent ships (no double-ship)', async () => {
    const { sink, readRows } = chain();
    await append(sink, 3);
    const mirror = new InMemoryAuditMirror();
    const signer = new InMemoryHmacSigner();
    const shipper = new WormShipper({ mirror, signer, verifier: signer, readRows });

    const [a, b] = await Promise.all([shipper.ship(), shipper.ship()]);
    const total = a.shipped + b.shipped;
    expect(total).toBe(3); // exactly once, not 6
    expect(await shipper.verify()).toEqual({ ok: true, rows: 3, lastSeq: 3 });
    expect(await mirror.list()).toHaveLength(1);
  });

  it('fails closed when the existing WORM record does not verify (wrong key / tamper)', async () => {
    const { sink, readRows } = chain();
    await append(sink, 2);
    const mirror = new InMemoryAuditMirror();
    // Record was signed under one key...
    await new WormShipper({
      mirror,
      signer: new InMemoryHmacSigner(Buffer.alloc(32, 1)),
      verifier: new InMemoryHmacSigner(Buffer.alloc(32, 1)),
      readRows,
    }).ship();

    // ...but this shipper verifies under a DIFFERENT key — the signature check fails,
    // so it refuses to append rather than extend a record it cannot trust.
    await append(sink, 1, 2);
    const wrong = new InMemoryHmacSigner(Buffer.alloc(32, 2));
    const shipper = new WormShipper({ mirror, signer: wrong, verifier: wrong, readRows });
    await expect(shipper.ship()).rejects.toThrow(/integrity check failed/);
  });
});
