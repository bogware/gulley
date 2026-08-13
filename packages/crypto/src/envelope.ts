import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** An AES-256-GCM envelope: the payload encrypted under a per-message data key,
 *  which is itself wrapped (KMS CiphertextBlob, or an in-memory master key). */
export interface EnvelopeCiphertext {
  v: 1;
  keyClass: string;
  iv: string;
  tag: string;
  ciphertext: string;
  wrappedKey: string;
}

export interface EncryptContext {
  keyClass: string;
  aad?: string;
}

/** Split-key envelope encryptor. Fail-closed on decrypt (unknown version/class,
 *  or an AAD/context mismatch, throws). */
export interface Encryptor {
  encrypt(plaintext: Uint8Array, ctx: EncryptContext): Promise<EnvelopeCiphertext>;
  decrypt(ct: EnvelopeCiphertext, ctx?: { aad?: string }): Promise<Uint8Array>;
}

function aad(keyClass: string, extra?: string): Buffer {
  return Buffer.from(`${keyClass}:${extra ?? ''}`);
}

function gcmEncrypt(key: Buffer, plaintext: Uint8Array, associated: Buffer) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(associated);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv, tag: c.getAuthTag(), ct };
}

function gcmDecrypt(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer, associated: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(associated);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/** Local envelope encryptor with per-class master keys — the CI/dev twin of the
 *  KMS encryptor (identical envelope shape and fail-closed semantics). */
export class InMemoryAesCipher implements Encryptor {
  private readonly masters = new Map<string, Buffer>();

  private master(keyClass: string): Buffer {
    let m = this.masters.get(keyClass);
    if (!m) {
      m = randomBytes(32);
      this.masters.set(keyClass, m);
    }
    return m;
  }

  async encrypt(plaintext: Uint8Array, ctx: EncryptContext): Promise<EnvelopeCiphertext> {
    const dek = randomBytes(32);
    const body = gcmEncrypt(dek, plaintext, aad(ctx.keyClass, ctx.aad));
    const wrap = gcmEncrypt(this.master(ctx.keyClass), dek, Buffer.from(ctx.keyClass));
    dek.fill(0);
    return {
      v: 1,
      keyClass: ctx.keyClass,
      iv: body.iv.toString('base64'),
      tag: body.tag.toString('base64'),
      ciphertext: body.ct.toString('base64'),
      wrappedKey: Buffer.concat([wrap.iv, wrap.tag, wrap.ct]).toString('base64'),
    };
  }

  async decrypt(ct: EnvelopeCiphertext, ctx?: { aad?: string }): Promise<Uint8Array> {
    if (ct.v !== 1) throw new Error(`unsupported envelope version: ${String(ct.v)}`);
    const master = this.masters.get(ct.keyClass);
    if (!master) throw new Error(`unknown key class: ${ct.keyClass}`);
    const w = Buffer.from(ct.wrappedKey, 'base64');
    const dek = gcmDecrypt(
      master,
      w.subarray(0, 12),
      w.subarray(12, 28),
      w.subarray(28),
      Buffer.from(ct.keyClass),
    );
    const out = gcmDecrypt(
      dek,
      Buffer.from(ct.iv, 'base64'),
      Buffer.from(ct.tag, 'base64'),
      Buffer.from(ct.ciphertext, 'base64'),
      aad(ct.keyClass, ctx?.aad),
    );
    dek.fill(0);
    return new Uint8Array(out);
  }
}

/**
 * KMS envelope encryptor. Each message gets a fresh data key from KMS
 * (GenerateDataKey) bound to an encryption context = {class, aad}, so KMS Decrypt
 * fails if the context differs (per-class isolation). The SDK is imported lazily
 * so the container boots without it.
 */
export class KmsEnvelopeEncryptor implements Encryptor {
  private client: unknown;

  constructor(
    private readonly keyId: string,
    private readonly region: string,
  ) {}

  private async kms(): Promise<{
    send: (cmd: unknown) => Promise<{ Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array }>;
    GenerateDataKeyCommand: new (input: unknown) => unknown;
    DecryptCommand: new (input: unknown) => unknown;
  }> {
    const mod = (await import('@aws-sdk/client-kms')) as unknown as {
      KMSClient: new (cfg: { region: string }) => { send: (cmd: unknown) => Promise<unknown> };
      GenerateDataKeyCommand: new (input: unknown) => unknown;
      DecryptCommand: new (input: unknown) => unknown;
    };
    if (!this.client) this.client = new mod.KMSClient({ region: this.region });
    const client = this.client as {
      send: (cmd: unknown) => Promise<{ Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array }>;
    };
    return {
      send: (cmd) => client.send(cmd),
      GenerateDataKeyCommand: mod.GenerateDataKeyCommand,
      DecryptCommand: mod.DecryptCommand,
    };
  }

  private context(keyClass: string, extra?: string): Record<string, string> {
    return extra ? { class: keyClass, aad: extra } : { class: keyClass };
  }

  async encrypt(plaintext: Uint8Array, ctx: EncryptContext): Promise<EnvelopeCiphertext> {
    const kms = await this.kms();
    const res = await kms.send(
      new kms.GenerateDataKeyCommand({
        KeyId: this.keyId,
        KeySpec: 'AES_256',
        EncryptionContext: this.context(ctx.keyClass, ctx.aad),
      }),
    );
    const dek = Buffer.from(res.Plaintext as Uint8Array);
    const body = gcmEncrypt(dek, plaintext, aad(ctx.keyClass, ctx.aad));
    dek.fill(0);
    return {
      v: 1,
      keyClass: ctx.keyClass,
      iv: body.iv.toString('base64'),
      tag: body.tag.toString('base64'),
      ciphertext: body.ct.toString('base64'),
      wrappedKey: Buffer.from(res.CiphertextBlob as Uint8Array).toString('base64'),
    };
  }

  async decrypt(ct: EnvelopeCiphertext, ctx?: { aad?: string }): Promise<Uint8Array> {
    if (ct.v !== 1) throw new Error(`unsupported envelope version: ${String(ct.v)}`);
    const kms = await this.kms();
    const res = await kms.send(
      new kms.DecryptCommand({
        CiphertextBlob: Buffer.from(ct.wrappedKey, 'base64'),
        EncryptionContext: this.context(ct.keyClass, ctx?.aad),
      }),
    );
    const dek = Buffer.from(res.Plaintext as Uint8Array);
    const out = gcmDecrypt(
      dek,
      Buffer.from(ct.iv, 'base64'),
      Buffer.from(ct.tag, 'base64'),
      Buffer.from(ct.ciphertext, 'base64'),
      aad(ct.keyClass, ctx?.aad),
    );
    dek.fill(0);
    return new Uint8Array(out);
  }
}
