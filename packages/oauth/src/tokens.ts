import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Broker tokens are opaque handles with a high-entropy secret; only the HMAC of
// the secret is persisted (mirrors the virtual-key scheme). The handle is the
// grant/family id, so every token is revocable server-side.
const AT_PREFIX = 'gko_at_';
const RT_PREFIX = 'gko_rt_';

export interface ParsedAccess {
  handle: string;
  secret: string;
}

export interface ParsedRefresh {
  handle: string;
  generation: number;
  secret: string;
}

export function newHandle(): string {
  return randomBytes(12).toString('hex');
}

export function tokenHash(pepper: string, secret: string): string {
  return createHmac('sha256', pepper).update(secret).digest('hex');
}

export function mintAccessToken(pepper: string, handle: string): { token: string; hash: string } {
  const secret = randomBytes(32).toString('base64url');
  return { token: `${AT_PREFIX}${handle}.${secret}`, hash: tokenHash(pepper, secret) };
}

export function mintRefreshToken(
  pepper: string,
  handle: string,
  generation: number,
): { token: string; hash: string } {
  const secret = randomBytes(32).toString('base64url');
  return {
    token: `${RT_PREFIX}${handle}.${generation}.${secret}`,
    hash: tokenHash(pepper, secret),
  };
}

export function parseAccess(token: string): ParsedAccess | null {
  if (!token.startsWith(AT_PREFIX)) return null;
  const rest = token.slice(AT_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot === rest.length - 1) return null;
  return { handle: rest.slice(0, dot), secret: rest.slice(dot + 1) };
}

export function parseRefresh(token: string): ParsedRefresh | null {
  if (!token.startsWith(RT_PREFIX)) return null;
  const parts = token.slice(RT_PREFIX.length).split('.');
  if (parts.length !== 3) return null;
  const [handle, genStr, secret] = parts;
  const generation = Number(genStr);
  if (!handle || !secret || !genStr || !Number.isInteger(generation) || generation < 0) return null;
  return { handle, generation, secret };
}

/** Constant-time compare of a presented secret against a stored HMAC. Returns
 *  false (never throws) on a null/short/mismatched hash. */
export function verifyHash(pepper: string, secret: string, expected: string | null): boolean {
  if (!expected) return false;
  const a = Buffer.from(tokenHash(pepper, secret));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
