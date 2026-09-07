import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { EncryptContext, Encryptor, EnvelopeCiphertext } from './envelope';

/**
 * BYOK + crypto-shred.
 *
 * Data-at-rest (the mask vault's token↔original PII maps) is encrypted under a PER-
 * SUBJECT key (subject = the principal / virtual key). Those subject keys are themselves
 * held WRAPPED by the deployment master key — the customer's own KMS CMK (BYOK) — so:
 *   - destroying the master CMK makes ALL subjects' data unreadable (whole-deployment
 *     erasure), and
 *   - destroying ONE subject's key (crypto-shred) makes only THAT subject's data
 *     permanently unrecoverable — provable, irreversible GDPR/CCPA erasure with no row
 *     deletion. Old ciphertexts stay in place but can never be decrypted again.
 *
 * ShreddableCipher implements the plain {@link Encryptor} interface, so it drops in as
 * the mask-vault encryptor/decryptor. A ciphertext records its subject in `keyClass`
 * (`subject:<id>`) so decrypt is self-describing; a payload with no `subject` context
 * falls through to the master cipher unchanged.
 */
const SUBJECT_PREFIX = 'subject:';

/** Durable registry of per-subject keys. Keys are stored WRAPPED (master-encrypted) at
 *  rest; `shred` destroys the wrapping so the subject's data is unrecoverable. */
export interface SubjectKeyStore {
  /** The subject's raw 256-bit key, creating + persisting it (wrapped) if absent or if
   *  a prior shred left it empty (new data gets a fresh key; old data stays shredded). */
  getOrCreate(subject: string): Promise<Buffer>;
  /** The subject's raw key, or undefined when it was never created OR was shredded. */
  get(subject: string): Promise<Buffer | undefined>;
  /** Destroy the subject's key material — crypto-shred. Idempotent. */
  shred(subject: string): Promise<void>;
}

/** In-memory SubjectKeyStore twin (dev/CI). */
export class InMemorySubjectKeyStore implements SubjectKeyStore {
  private readonly keys = new Map<string, Buffer>();

  async getOrCreate(subject: string): Promise<Buffer> {
    let k = this.keys.get(subject);
    if (!k) {
      k = randomBytes(32);
      this.keys.set(subject, k);
    }
    return k;
  }
  async get(subject: string): Promise<Buffer | undefined> {
    return this.keys.get(subject);
  }
  async shred(subject: string): Promise<void> {
    this.keys.delete(subject);
  }
}

function subjectAad(subject: string, extra?: string): Buffer {
  return Buffer.from(`${SUBJECT_PREFIX}${subject}:${extra ?? ''}`);
}

/** A subject payload is AES-256-GCM under the subject key directly (fresh IV per
 *  message); no per-message wrapped DEK (the subject key IS the destroyable key). */
export class ShreddableCipher implements Encryptor {
  constructor(
    private readonly master: Encryptor,
    private readonly keys: SubjectKeyStore,
  ) {}

  async encrypt(plaintext: Uint8Array, ctx: EncryptContext): Promise<EnvelopeCiphertext> {
    if (!ctx.subject) return this.master.encrypt(plaintext, ctx);
    const key = await this.keys.getOrCreate(ctx.subject);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(subjectAad(ctx.subject, ctx.aad));
    const ct = Buffer.concat([c.update(plaintext), c.final()]);
    return {
      v: 1,
      keyClass: `${SUBJECT_PREFIX}${ctx.subject}`,
      iv: iv.toString('base64'),
      tag: c.getAuthTag().toString('base64'),
      ciphertext: ct.toString('base64'),
      wrappedKey: '', // the subject key is the destroyable key; nothing per-message to wrap
    };
  }

  async decrypt(ct: EnvelopeCiphertext, opts?: { aad?: string }): Promise<Uint8Array> {
    if (!ct.keyClass.startsWith(SUBJECT_PREFIX)) return this.master.decrypt(ct, opts);
    if (ct.v !== 1) throw new Error(`unsupported envelope version: ${String(ct.v)}`);
    const subject = ct.keyClass.slice(SUBJECT_PREFIX.length);
    const key = await this.keys.get(subject);
    // Crypto-shredded (or never written): the key is gone, so the data is unrecoverable.
    if (!key) throw new Error(`crypto-shredded: no key for subject "${subject}"`);
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ct.iv, 'base64'));
    d.setAAD(subjectAad(subject, opts?.aad));
    d.setAuthTag(Buffer.from(ct.tag, 'base64'));
    const out = Buffer.concat([d.update(Buffer.from(ct.ciphertext, 'base64')), d.final()]);
    return new Uint8Array(out);
  }
}
