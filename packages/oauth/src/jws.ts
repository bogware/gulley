import { err, ok, type Result } from '@gulley/core';
import { createVerify, type KeyObject } from 'node:crypto';

export interface JwtClaims {
  iss?: string;
  aud?: string | string[];
  tid?: string;
  nonce?: string;
  sub?: string;
  exp?: number;
  [k: string]: unknown;
}

function decodeSegment(seg: string): unknown {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

/**
 * Verify a compact JWS signed with ES256 — the algorithm is HARD-PINNED, so
 * `alg: none`, `HS256` (key-confusion), and any other alg are rejected before a
 * signature check. Uses raw (IEEE-P1363) ECDSA encoding, the JOSE format.
 */
export function verifyEs256(jwt: string, publicKey: KeyObject): Result<JwtClaims, 'bad_jws'> {
  const parts = jwt.split('.');
  if (parts.length !== 3) return err('bad_jws');
  const [h, p, s] = parts;
  if (!h || !p || !s) return err('bad_jws');

  let header: { alg?: string };
  try {
    header = decodeSegment(h) as { alg?: string };
  } catch {
    return err('bad_jws');
  }
  if (header.alg !== 'ES256') return err('bad_jws'); // hard pin — no downgrade

  try {
    const v = createVerify('SHA256');
    v.update(`${h}.${p}`);
    v.end();
    const good = v.verify(
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    );
    if (!good) return err('bad_jws');
    return ok(decodeSegment(p) as JwtClaims);
  } catch {
    return err('bad_jws');
  }
}

export interface IdTokenExpectations {
  iss: string;
  aud: string;
  tid: string;
  nonce: string;
  now: number;
}

/** Validate the standard OIDC claims after an ES256 signature check. */
export function validateIdToken(
  claims: JwtClaims,
  exp: IdTokenExpectations,
): Result<JwtClaims, string> {
  if (claims.iss !== exp.iss) return err('bad-iss');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(exp.aud)) return err('bad-aud');
  if (claims.tid !== exp.tid) return err('bad-tid');
  if (claims.nonce !== exp.nonce) return err('bad-nonce');
  if (typeof claims.exp !== 'number' || Math.floor(exp.now / 1000) >= claims.exp)
    return err('expired');
  return ok(claims);
}
