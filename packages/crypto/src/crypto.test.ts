import { describe, expect, it } from 'vitest';
import { InMemoryAesCipher } from './envelope';
import { InMemoryHmacSigner, LocalKeypairSigner, verifyWithPublicKey } from './sign';

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

describe('LocalKeypairSigner / verifyWithPublicKey (asymmetric, offline-verifiable)', () => {
  it('signs, self-verifies, and is verifiable offline with only the public key', async () => {
    const s = new LocalKeypairSigner();
    const data = enc.encode('worm-batch-hash');
    const sig = await s.sign(data);
    expect(await s.verify(data, sig)).toBe(true);

    // An external auditor holds only the SPKI public-key PEM — no KMS, no secret.
    const pem = await s.publicKeyPem();
    expect(pem).toContain('BEGIN PUBLIC KEY');
    expect(verifyWithPublicKey(pem, data, sig)).toBe(true);
    expect(verifyWithPublicKey(pem, enc.encode('tampered'), sig)).toBe(false);
  });

  it('a signature does not verify under a different key', async () => {
    const a = new LocalKeypairSigner();
    const b = new LocalKeypairSigner();
    const data = enc.encode('x');
    const sig = await a.sign(data);
    expect(verifyWithPublicKey(await b.publicKeyPem(), data, sig)).toBe(false);
    expect(await b.verify(data, sig)).toBe(false);
  });

  it('a supplied private key gives a STABLE published public key across instances', async () => {
    const seed = new LocalKeypairSigner();
    // Reconstruct another signer from the same key material (exported PKCS#8 PEM).
    const privateKeyPem = (
      seed as unknown as { privateKey: { export(o: unknown): string | Buffer } }
    ).privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString();
    const s1 = new LocalKeypairSigner({ privateKeyPem });
    const s2 = new LocalKeypairSigner({ privateKeyPem });
    expect(await s1.publicKeyPem()).toBe(await s2.publicKeyPem());
    // A signature from one verifies under the other's (identical) public key.
    const sig = await s1.sign(enc.encode('stable'));
    expect(verifyWithPublicKey(await s2.publicKeyPem(), enc.encode('stable'), sig)).toBe(true);
  });

  it('verifyWithPublicKey fails closed on a malformed key or signature', () => {
    expect(verifyWithPublicKey('not-a-pem', enc.encode('x'), 'AAAA')).toBe(false);
  });
});
