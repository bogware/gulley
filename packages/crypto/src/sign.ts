import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

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
