import { describe, expect, it } from 'vitest';
import { InMemoryAesCipher } from './envelope';
import { InMemoryHmacSigner } from './sign';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('InMemoryAesCipher envelope', () => {
  it('round-trips and produces ciphertext != plaintext', async () => {
    const c = new InMemoryAesCipher();
    const ct = await c.encrypt(enc.encode('super-secret-refresh-token'), {
      keyClass: 'oauth-refresh',
    });
    expect(ct.ciphertext).not.toContain('secret');
    expect(dec.decode(await c.decrypt(ct))).toBe('super-secret-refresh-token');
  });

  it('fails closed on version, unknown class, and AAD mismatch', async () => {
    const c = new InMemoryAesCipher();
    const ct = await c.encrypt(enc.encode('x'), { keyClass: 'audit-export', aad: 'batch-1' });
    await expect(c.decrypt({ ...ct, v: 2 as unknown as 1 })).rejects.toThrow();
    await expect(c.decrypt({ ...ct, keyClass: 'other-class' })).rejects.toThrow();
    await expect(c.decrypt(ct, { aad: 'batch-2' })).rejects.toThrow(); // wrong AAD
    expect(dec.decode(await c.decrypt(ct, { aad: 'batch-1' }))).toBe('x');
  });

  it('a ciphertext of one class cannot be decrypted as another', async () => {
    const c = new InMemoryAesCipher();
    const a = await c.encrypt(enc.encode('classA'), { keyClass: 'A' });
    await expect(c.decrypt({ ...a, keyClass: 'B' })).rejects.toThrow();
  });
});

describe('InMemoryHmacSigner', () => {
  it('signs and verifies; a tampered payload fails', async () => {
    const s = new InMemoryHmacSigner();
    const data = enc.encode('batch-preimage');
    const sig = await s.sign(data);
    expect(await s.verify(data, sig)).toBe(true);
    expect(await s.verify(enc.encode('tampered'), sig)).toBe(false);
    expect(await s.verify(data, sig.slice(0, -2) + 'aa')).toBe(false);
  });
});
