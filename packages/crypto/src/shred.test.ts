import { describe, expect, it } from 'vitest';
import { InMemoryAesCipher } from './envelope';
import { InMemorySubjectKeyStore, ShreddableCipher } from './shred';

const enc = new TextEncoder();
const dec = new TextDecoder();

const AAD = 'req-1:ws-1:input';

describe('ShreddableCipher (BYOK + crypto-shred)', () => {
  it('round-trips a per-subject payload and hides the plaintext', async () => {
    const c = new ShreddableCipher(new InMemoryAesCipher(), new InMemorySubjectKeyStore());
    const ct = await c.encrypt(enc.encode('alice@example.com'), {
      keyClass: 'mask-vault',
      aad: AAD,
      subject: 'user-alice',
    });
    expect(ct.keyClass).toBe('subject:user-alice');
    expect(ct.wrappedKey).toBe(''); // the subject key IS the destroyable key
    expect(ct.ciphertext).not.toContain('alice');
    expect(dec.decode(await c.decrypt(ct, { aad: AAD }))).toBe('alice@example.com');
  });

  it('after a shred the ciphertext is permanently unrecoverable', async () => {
    const keys = new InMemorySubjectKeyStore();
    const c = new ShreddableCipher(new InMemoryAesCipher(), keys);
    const ct = await c.encrypt(enc.encode('pii'), {
      keyClass: 'mask-vault',
      aad: AAD,
      subject: 'user-bob',
    });
    // Decrypts before the shred...
    expect(dec.decode(await c.decrypt(ct, { aad: AAD }))).toBe('pii');
    await keys.shred('user-bob');
    // ...and is unrecoverable after (the key is gone) — fails closed, distinctly.
    await expect(c.decrypt(ct, { aad: AAD })).rejects.toThrow('crypto-shredded');
  });

  it('shred is subject-scoped: other subjects are unaffected', async () => {
    const keys = new InMemorySubjectKeyStore();
    const c = new ShreddableCipher(new InMemoryAesCipher(), keys);
    const a = await c.encrypt(enc.encode('a-pii'), {
      keyClass: 'mask-vault',
      aad: AAD,
      subject: 'a',
    });
    const b = await c.encrypt(enc.encode('b-pii'), {
      keyClass: 'mask-vault',
      aad: AAD,
      subject: 'b',
    });
    await keys.shred('a');
    await expect(c.decrypt(a, { aad: AAD })).rejects.toThrow('crypto-shredded');
    expect(dec.decode(await c.decrypt(b, { aad: AAD }))).toBe('b-pii');
  });

  it('a fresh write after a shred gets a NEW key; old data stays unrecoverable', async () => {
    const keys = new InMemorySubjectKeyStore();
    const c = new ShreddableCipher(new InMemoryAesCipher(), keys);
    const old = await c.encrypt(enc.encode('old'), {
      keyClass: 'mask-vault',
      aad: AAD,
      subject: 's',
    });
    await keys.shred('s');
    const fresh = await c.encrypt(enc.encode('new'), {
      keyClass: 'mask-vault',
      aad: AAD,
      subject: 's',
    });
    expect(dec.decode(await c.decrypt(fresh, { aad: AAD }))).toBe('new');
    // The old ciphertext is gone for good — the new key can't authenticate it (GCM tag
    // failure), so a shred is NOT reversible by re-writing the subject.
    await expect(c.decrypt(old, { aad: AAD })).rejects.toThrow();
  });

  it('fails closed on an AAD mismatch (context binding)', async () => {
    const c = new ShreddableCipher(new InMemoryAesCipher(), new InMemorySubjectKeyStore());
    const ct = await c.encrypt(enc.encode('x'), { keyClass: 'mask-vault', aad: AAD, subject: 's' });
    await expect(c.decrypt(ct, { aad: 'req-2:ws-1:input' })).rejects.toThrow();
    expect(dec.decode(await c.decrypt(ct, { aad: AAD }))).toBe('x');
  });

  it('without a subject, falls through to the master cipher unchanged (BYOK-only)', async () => {
    const master = new InMemoryAesCipher();
    const c = new ShreddableCipher(master, new InMemorySubjectKeyStore());
    const ct = await c.encrypt(enc.encode('token'), { keyClass: 'oauth-refresh' });
    expect(ct.keyClass).toBe('oauth-refresh'); // not a subject envelope
    expect(ct.wrappedKey).not.toBe(''); // master wraps a per-message DEK
    // A master-produced ciphertext decrypts through the ShreddableCipher AND the bare master.
    expect(dec.decode(await c.decrypt(ct))).toBe('token');
    expect(dec.decode(await master.decrypt(ct))).toBe('token');
  });
});
