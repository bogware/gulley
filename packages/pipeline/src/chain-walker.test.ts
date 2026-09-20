import { describe, expect, it } from 'vitest';
import { AuditChainWalker, verifyAuditChain } from './attestation';
import { InMemoryAuditSink } from './memory';

async function chain(n: number): Promise<InMemoryAuditSink> {
  const sink = new InMemoryAuditSink(() => new Date(1_700_000_000_000));
  for (let i = 0; i < n; i++) {
    await sink.append({ actor: 'a', action: `act.${i}`, target: `t${i}`, payload: { i } });
  }
  return sink;
}

describe('AuditChainWalker — incremental verification', () => {
  it('matches verifyAuditChain on an intact chain fed in batches', async () => {
    const sink = await chain(1_000);
    const w = new AuditChainWalker();
    for (let i = 0; i < sink.rows.length; i += 128) {
      for (const r of sink.rows.slice(i, i + 128)) w.push(r);
    }
    expect(w.report()).toEqual(verifyAuditChain(sink.rows));
    expect(w.report().verified).toBe(true);
    expect(w.report().count).toBe(1_000);
  });

  it('reports the first broken seq and stays broken (a later good row cannot heal it)', async () => {
    const sink = await chain(20);
    const rows = sink.rows.map((r) => ({ ...r }));
    rows[7]!.payload = { tampered: true };
    const w = new AuditChainWalker();
    for (const r of rows) w.push(r);
    const rep = w.report();
    expect(rep.verified).toBe(false);
    expect(rep.brokenAtSeq).toBe(8);
    expect(rep.count).toBe(20);
    expect(rep).toEqual(verifyAuditChain(rows));
  });

  it('a gap or a repeated seq breaks the chain', async () => {
    const sink = await chain(5);
    const rows = sink.rows.filter((r) => r.seq !== 3);
    expect(verifyAuditChain(rows).brokenAtSeq).toBe(4);
    const w = new AuditChainWalker();
    expect(w.report()).toMatchObject({ verified: true, count: 0, firstSeq: null, lastSeq: null });
  });
});
