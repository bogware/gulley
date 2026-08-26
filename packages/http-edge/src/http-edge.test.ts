import { describe, expect, it } from 'vitest';
import {
  type CorsConfig,
  corsAllows,
  corsPreflightHeaders,
  corsResponseHeaders,
  csrfBlocked,
  isCorsPreflight,
} from './index';

const cfg = (origins: string[]): CorsConfig => ({ origins: new Set(origins) });

describe('CORS (credentials-safe)', () => {
  const c = cfg(['https://admin.example.com']);

  it('reflects an exact allowlisted origin with credentials + Vary', () => {
    expect(corsResponseHeaders('https://admin.example.com', c)).toEqual({
      'access-control-allow-origin': 'https://admin.example.com',
      'access-control-allow-credentials': 'true',
      vary: 'Origin',
    });
  });

  it('emits nothing for a non-allowlisted or absent origin (never a wildcard)', () => {
    expect(corsResponseHeaders('https://evil.example.com', c)).toEqual({});
    expect(corsResponseHeaders(undefined, c)).toEqual({});
    expect(corsAllows('https://evil.example.com', c)).toBe(false);
    // Empty allowlist = CORS entirely off (same-origin proxy deployment).
    expect(corsResponseHeaders('https://admin.example.com', cfg([]))).toEqual({});
  });

  it('builds a full preflight header set only for an allowlisted OPTIONS', () => {
    expect(isCorsPreflight('OPTIONS', 'https://admin.example.com', c)).toBe(true);
    expect(isCorsPreflight('OPTIONS', 'https://evil.example.com', c)).toBe(false);
    expect(isCorsPreflight('POST', 'https://admin.example.com', c)).toBe(false);
    const pf = corsPreflightHeaders('https://admin.example.com', c);
    expect(pf['access-control-allow-credentials']).toBe('true');
    expect(pf['access-control-allow-methods']).toContain('POST');
    expect(pf['access-control-max-age']).toBe('600');
  });
});

describe('CSRF (Sec-Fetch-Site)', () => {
  it('blocks a cookie-authed cross-site/same-site unsafe request', () => {
    expect(csrfBlocked({ method: 'POST', secFetchSite: 'cross-site', hasAuthHeader: false })).toBe(
      true,
    );
    expect(csrfBlocked({ method: 'DELETE', secFetchSite: 'same-site', hasAuthHeader: false })).toBe(
      true,
    );
  });

  it('allows same-origin, header-absent, safe methods, and token-authed requests', () => {
    expect(csrfBlocked({ method: 'POST', secFetchSite: 'same-origin', hasAuthHeader: false })).toBe(
      false,
    );
    expect(csrfBlocked({ method: 'POST', secFetchSite: 'none', hasAuthHeader: false })).toBe(false);
    expect(csrfBlocked({ method: 'POST', secFetchSite: undefined, hasAuthHeader: false })).toBe(
      false,
    ); // non-browser client
    expect(csrfBlocked({ method: 'GET', secFetchSite: 'cross-site', hasAuthHeader: false })).toBe(
      false,
    ); // safe method
    expect(csrfBlocked({ method: 'POST', secFetchSite: 'cross-site', hasAuthHeader: true })).toBe(
      false,
    ); // Bearer: not a CSRF vector
  });
});
