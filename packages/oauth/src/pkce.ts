import { createHash, timingSafeEqual } from 'node:crypto';

export function pkceChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** PKCE S256 verification: BASE64URL(SHA256(verifier)) === challenge (constant-time). */
export function pkceVerifyS256(verifier: string, challenge: string): boolean {
  const a = Buffer.from(pkceChallengeS256(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Exact-match loopback redirect: http on 127.0.0.1 / [::1] / localhost with any
 * (dynamic) port, an exact pathname in the allowlist, and no userinfo / query /
 * fragment. The dynamic port is intentionally not pinned (native OAuth apps).
 */
export function validateLoopbackRedirect(
  redirectUri: string,
  allowlist: readonly string[],
): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  // WHATWG URL reports an IPv6 host WITH its brackets (`[::1]`), so match that form
  // too — otherwise the IPv6 loopback a native harness may bind is never accepted.
  if (!['127.0.0.1', '::1', '[::1]', 'localhost'].includes(url.hostname)) return false;
  if (url.username || url.password || url.search || url.hash) return false;
  return allowlist.includes(url.pathname);
}
