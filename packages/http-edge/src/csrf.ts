/**
 * CSRF protection via the `Sec-Fetch-Site` fetch-metadata header. A cross-site
 * browser request carries `Sec-Fetch-Site: cross-site`; a forged form-POST from
 * a malicious page cannot suppress it. We reject an unsafe (state-changing)
 * request ONLY when it is cookie-authenticated AND the header proves a cross-site
 * origin.
 *
 * Deliberately permissive at the edges to avoid breaking legitimate callers:
 *  - Bearer/API-key requests are exempt — an Authorization header cannot be set
 *    by a cross-site form, so it is not a CSRF vector.
 *  - A missing header (non-browser API clients, older agents) is allowed — those
 *    clients are not browsers and cannot be driven by a CSRF attack.
 *  - `same-origin` and `none` (a user-initiated navigation) are allowed.
 */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface CsrfRequest {
  method: string;
  /** The `Sec-Fetch-Site` header value, if present. */
  secFetchSite: string | undefined;
  /** Whether the request carries an Authorization header (Bearer/API key). */
  hasAuthHeader: boolean;
}

/** True when the request should be rejected as a probable CSRF attempt. */
export function csrfBlocked(req: CsrfRequest): boolean {
  if (!UNSAFE_METHODS.has(req.method.toUpperCase())) return false; // safe method
  if (req.hasAuthHeader) return false; // token-authed: not a CSRF vector
  const site = req.secFetchSite;
  if (site === undefined) return false; // non-browser client
  // Only an explicit cross-site (or cross-origin subdomain) fetch is blocked.
  return site === 'cross-site' || site === 'same-site';
}
