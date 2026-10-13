/** Cookie names + a dependency-free parse/serialize used by the SSO gates and the
 *  admin-session resolver. Kept apart from the gates so `sso.ts` and `oidc-gate.ts`
 *  share it without importing each other. */

export const SESSION_COOKIE = 'gulley_admin_session';

const COOKIE_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Parse a Cookie header into a prototype-less map. Only well-formed names are kept
 *  (so a client-chosen name can never address `__proto__` or a prototype property),
 *  and a value that is not valid percent-encoding is skipped rather than thrown on. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (!COOKIE_NAME_RE.test(name)) continue;
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* malformed percent-encoding: ignore this cookie */
    }
  }
  return out;
}

export interface CookieOptions {
  maxAge?: number;
  secure?: boolean;
  httpOnly?: boolean;
  path?: string;
  /** Default `Lax`. `null` omits the attribute entirely (the SAML flow cookie on a
   *  non-TLS dev edge, where `None` would be rejected without `Secure`). */
  sameSite?: 'Lax' | 'Strict' | 'None' | null;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`];
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.sameSite !== null) parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  if (opts.secure) parts.push('Secure');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}

export function clearCookie(name: string, opts: CookieOptions = {}): string {
  return serializeCookie(name, '', { ...opts, maxAge: 0 });
}
