import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign as nodeSign,
  timingSafeEqual,
  verify as nodeVerify,
} from 'node:crypto';

/** Signs a byte string (a WORM batch preimage). KMS Sign under an `audit-export`
 *  CMK is the prod signer; the HMAC signer below is the CI/dev twin. */
export interface Signer {
  sign(data: Uint8Array): Promise<string>;
}

export interface BatchVerifier {
  verify(data: Uint8Array, signature: string): Promise<boolean>;
}

export class InMemoryHmacSigner implements Signer, BatchVerifier {
  constructor(private readonly key: Buffer = randomBytes(32)) {}

  async sign(data: Uint8Array): Promise<string> {
    return createHmac('sha256', this.key).update(data).digest('base64');
  }

  async verify(data: Uint8Array, signature: string): Promise<boolean> {
    const expected = createHmac('sha256', this.key).update(data).digest();
    const got = Buffer.from(signature, 'base64');
    return expected.length === got.length && timingSafeEqual(expected, got);
  }
}

/** AWS KMS asymmetric signing algorithms this module supports. ECDSA_SHA_256 (an
 *  ECC_NIST_P256 CMK) is the default — compact signatures, cheap to verify. */
export type SigningAlgorithm =
  | 'ECDSA_SHA_256'
  | 'ECDSA_SHA_384'
  | 'ECDSA_SHA_512'
  | 'RSASSA_PKCS1_V1_5_SHA_256'
  | 'RSASSA_PKCS1_V1_5_SHA_384'
  | 'RSASSA_PKCS1_V1_5_SHA_512';

const HASH_FOR: Record<SigningAlgorithm, 'sha256' | 'sha384' | 'sha512'> = {
  ECDSA_SHA_256: 'sha256',
  ECDSA_SHA_384: 'sha384',
  ECDSA_SHA_512: 'sha512',
  RSASSA_PKCS1_V1_5_SHA_256: 'sha256',
  RSASSA_PKCS1_V1_5_SHA_384: 'sha384',
  RSASSA_PKCS1_V1_5_SHA_512: 'sha512',
};

/**
 * Verify an asymmetric signature OFFLINE with only the SPKI public-key PEM — exactly
 * what an external auditor runs: no KMS access, no shared secret. Both the KMS signer
 * and the local twin below produce signatures this accepts (KMS returns DER-encoded
 * ECDSA / PKCS#1 v1.5 signatures, which node verifies directly). Fail-closed: any bad
 * key, wrong algorithm, or malformed signature returns false rather than throwing.
 */
export function verifyWithPublicKey(
  publicKeyPem: string,
  data: Uint8Array,
  signatureBase64: string,
  algorithm: SigningAlgorithm = 'ECDSA_SHA_256',
): boolean {
  try {
    return nodeVerify(
      HASH_FOR[algorithm],
      Buffer.from(data),
      createPublicKey(publicKeyPem),
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
}

/** A signer that also publishes the public key needed to verify it offline. The WORM
 *  batch signer and the audit attestation signer are both this shape, so one published
 *  key lets an auditor verify everything without KMS or a shared secret. */
export interface AsymmetricSigner extends Signer, BatchVerifier {
  /** SPKI PEM public key (cached); what /audit/public-key serves to auditors. */
  publicKeyPem(): Promise<string>;
  readonly algorithm: SigningAlgorithm;
}

/**
 * Local asymmetric signer — the CI/dev twin of {@link KmsSigner} (same
 * AsymmetricSigner contract, same signature format, offline-verifiable). Generates an
 * ephemeral ECC P-256 keypair when none is supplied, so WORM/attestation can run with
 * a real public-key story without KMS. NOT for prod (the private key lives in-process).
 */
export class LocalKeypairSigner implements AsymmetricSigner {
  readonly algorithm: SigningAlgorithm;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(opts?: { privateKeyPem?: string; algorithm?: SigningAlgorithm }) {
    this.algorithm = opts?.algorithm ?? 'ECDSA_SHA_256';
    if (opts?.privateKeyPem) {
      // A supplied key gives a STABLE published public key across restarts.
      this.privateKey = createPrivateKey(opts.privateKeyPem);
      this.publicKey = createPublicKey(this.privateKey);
    } else {
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      this.privateKey = privateKey;
      this.publicKey = publicKey;
    }
  }

  async sign(data: Uint8Array): Promise<string> {
    return nodeSign(HASH_FOR[this.algorithm], Buffer.from(data), this.privateKey).toString(
      'base64',
    );
  }

  async verify(data: Uint8Array, signature: string): Promise<boolean> {
    return verifyWithPublicKey(await this.publicKeyPem(), data, signature, this.algorithm);
  }

  async publicKeyPem(): Promise<string> {
    return this.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  }
}

interface KmsSignApi {
  send: (cmd: unknown) => Promise<{ Signature?: Uint8Array; PublicKey?: Uint8Array }>;
  SignCommand: new (input: unknown) => unknown;
  GetPublicKeyCommand: new (input: unknown) => unknown;
}

/**
 * KMS asymmetric signer for the audit-export identity. `sign` calls KMS Sign under an
 * asymmetric CMK; `verify` fetches the public key ONCE (KMS GetPublicKey, cached) and
 * verifies LOCALLY — so the verify path needs no kms:Verify permission and is exactly
 * the offline check an auditor performs with the published key. The SDK is imported
 * lazily so the container boots without it.
 */
export class KmsSigner implements AsymmetricSigner {
  private client: unknown;
  private cachedPublicKeyPem?: string;

  constructor(
    private readonly keyId: string,
    private readonly region: string,
    readonly algorithm: SigningAlgorithm = 'ECDSA_SHA_256',
  ) {}

  private async kms(): Promise<KmsSignApi> {
    const mod = (await import('@aws-sdk/client-kms')) as unknown as {
      KMSClient: new (cfg: { region: string }) => { send: (cmd: unknown) => Promise<unknown> };
      SignCommand: new (input: unknown) => unknown;
      GetPublicKeyCommand: new (input: unknown) => unknown;
    };
    if (!this.client) this.client = new mod.KMSClient({ region: this.region });
    const client = this.client as {
      send: (cmd: unknown) => Promise<{ Signature?: Uint8Array; PublicKey?: Uint8Array }>;
    };
    return {
      send: (cmd) => client.send(cmd),
      SignCommand: mod.SignCommand,
      GetPublicKeyCommand: mod.GetPublicKeyCommand,
    };
  }

  async sign(data: Uint8Array): Promise<string> {
    const kms = await this.kms();
    const res = await kms.send(
      new kms.SignCommand({
        KeyId: this.keyId,
        Message: Buffer.from(data),
        MessageType: 'RAW',
        SigningAlgorithm: this.algorithm,
      }),
    );
    if (!res.Signature) throw new Error('KMS Sign returned no signature');
    return Buffer.from(res.Signature).toString('base64');
  }

  async verify(data: Uint8Array, signature: string): Promise<boolean> {
    return verifyWithPublicKey(await this.publicKeyPem(), data, signature, this.algorithm);
  }

  async publicKeyPem(): Promise<string> {
    if (this.cachedPublicKeyPem) return this.cachedPublicKeyPem;
    const kms = await this.kms();
    const res = await kms.send(new kms.GetPublicKeyCommand({ KeyId: this.keyId }));
    if (!res.PublicKey) throw new Error('KMS GetPublicKey returned no key');
    // KMS returns the public key as DER (SPKI); re-export it as PEM for auditors.
    const pem = createPublicKey({ key: Buffer.from(res.PublicKey), format: 'der', type: 'spki' })
      .export({ format: 'pem', type: 'spki' })
      .toString();
    this.cachedPublicKeyPem = pem;
    return pem;
  }
}
