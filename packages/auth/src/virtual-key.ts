import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Virtual key format: `gk_<id>_<secret>`
//   id     — 12 hex chars, public, stored + indexed as key_prefix (O(1) lookup)
//   secret — 32 random bytes (base64url), never stored; only its HMAC is kept
// The pepper is a KMS-held secret in production; the raw key is shown once.

const PREFIX = 'gk_';
const ID_BYTES = 6; // -> 12 hex chars
const ID_LEN = ID_BYTES * 2;
const SECRET_BYTES = 32; // >= 128 bits of entropy

export interface GeneratedKey {
  /** Full token, shown to the user exactly once. */
  token: string;
  /** Public lookup id (stored + unique-indexed). */
  keyPrefix: string;
  /** HMAC-SHA256(pepper, secret), hex — the only thing persisted. */
  keyHash: string;
}

export function hashSecret(pepper: string, secret: string): string {
  return createHmac('sha256', pepper).update(secret).digest('hex');
}

export function generateVirtualKey(pepper: string): GeneratedKey {
  const id = randomBytes(ID_BYTES).toString('hex');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return {
    token: `${PREFIX}${id}_${secret}`,
    keyPrefix: id,
    keyHash: hashSecret(pepper, secret),
  };
}

export interface ParsedKey {
  keyPrefix: string;
  secret: string;
}

/** Parse without validating the secret. Fixed-length id makes this deterministic
 *  even though the base64url secret may itself contain characters. */
export function parseVirtualKey(token: string): ParsedKey | null {
  if (!token.startsWith(PREFIX)) return null;
  const body = token.slice(PREFIX.length);
  if (body.length < ID_LEN + 2 || body[ID_LEN] !== '_') return null;
  const keyPrefix = body.slice(0, ID_LEN);
  const secret = body.slice(ID_LEN + 1);
  if (!/^[0-9a-f]+$/.test(keyPrefix) || keyPrefix.length !== ID_LEN || secret.length === 0) {
    return null;
  }
  return { keyPrefix, secret };
}

export function verifySecret(pepper: string, secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(pepper, secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Quick check that a credential looks like one of our virtual keys. */
export function isVirtualKey(token: string): boolean {
  return token.startsWith(PREFIX);
}
