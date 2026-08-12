import { describe, expect, it } from 'vitest';
import { canonicalize } from './audit';
import { InMemoryAuditSink } from './memory';

const fixedClock = () => new Date('2026-08-12T00:00:00.000Z');

describe('canonicalize', () => {
  it('sorts keys deterministically regardless of insertion order', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalize({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });
});

describe('InMemoryAuditSink', () => {
  it('builds a verifiable hash chain', async () => {
    const sink = new InMemoryAuditSink(fixedClock);
    await sink.append({ actor: 'vk_1', action: 'proxy.messages', target: 'anthropic' });
    await sink.append({ actor: 'vk_1', action: 'proxy.messages', target: 'anthropic' });
    await sink.append({ actor: 'admin', action: 'key.create' });

    expect(sink.rows).toHaveLength(3);
    expect(sink.rows[0]?.prevHash).toBeNull();
    expect(sink.rows[1]?.prevHash).toBe(sink.rows[0]?.rowHash);
    expect(sink.rows[2]?.prevHash).toBe(sink.rows[1]?.rowHash);
    expect(sink.verify()).toBe(true);
  });

  it('detects tampering with a row payload', async () => {
    const sink = new InMemoryAuditSink(fixedClock);
    await sink.append({ actor: 'vk_1', action: 'proxy.messages', payload: { model: 'a' } });
    await sink.append({ actor: 'vk_1', action: 'proxy.messages', payload: { model: 'b' } });
    expect(sink.verify()).toBe(true);

    // Mutate a row in place — the chain must no longer verify.
    sink.rows[0]!.action = 'tampered';
    expect(sink.verify()).toBe(false);
  });
});
