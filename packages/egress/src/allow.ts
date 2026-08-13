/**
 * SSRF egress guard. Blocks link-local/metadata (IMDS 169.254.169.254, ECS
 * 169.254.170.2), RFC1918, loopback, CGNAT, and IPv6 equivalents; enforces an
 * optional exact-host outbound allowlist; and rejects credentials-in-URL and
 * (by default) non-https. Structural half here (URL/IP literals); connect-time
 * DNS re-resolution (rebind defense) is added in the M5.4 dispatcher.
 */
export type EgressDenyReason =
  'invalid-url' | 'scheme' | 'userinfo' | 'blocked-ip' | 'not-allowlisted';

export class EgressError extends Error {
  constructor(
    readonly reason: EgressDenyReason,
    message: string,
  ) {
    super(message);
    this.name = 'EgressError';
  }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

function inCidr(ip: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base);
  if (b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (b & mask);
}

/** Is `host` a bare IP literal (not a name that must be resolved)? */
export function isIpLiteral(host: string): boolean {
  return ipv4ToInt(host) !== null || host.includes(':');
}

/** True for any internal / link-local / metadata / loopback address literal. */
export function isBlockedIp(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped?.[1]) return isBlockedIp(mapped[1]);
    return false;
  }
  const ip = ipv4ToInt(h);
  if (ip === null) return false;
  return (
    inCidr(ip, '127.0.0.0', 8) ||
    inCidr(ip, '10.0.0.0', 8) ||
    inCidr(ip, '172.16.0.0', 12) ||
    inCidr(ip, '192.168.0.0', 16) ||
    inCidr(ip, '169.254.0.0', 16) || // link-local incl. IMDS + ECS metadata
    inCidr(ip, '0.0.0.0', 8) ||
    inCidr(ip, '100.64.0.0', 10) // CGNAT
  );
}

export interface EgressOptions {
  /** Exact, lowercased hostnames allowed. Empty/absent = allow any non-blocked host. */
  allowlist?: ReadonlySet<string> | readonly string[];
  /** Require https. Default true. */
  requireHttps?: boolean;
}

function toSet(a: EgressOptions['allowlist']): ReadonlySet<string> | undefined {
  if (!a) return undefined;
  return Array.isArray(a) ? new Set(a.map((h) => h.toLowerCase())) : (a as ReadonlySet<string>);
}

/** Throw EgressError unless `rawUrl` is a safe outbound target. Returns the URL. */
export function assertEgressAllowed(rawUrl: string, opts: EgressOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressError('invalid-url', `not a URL: ${rawUrl}`);
  }
  if (opts.requireHttps !== false && url.protocol !== 'https:') {
    throw new EgressError('scheme', `non-https egress blocked: ${url.protocol}//`);
  }
  if (url.username || url.password) {
    throw new EgressError('userinfo', 'credentials embedded in URL are not allowed');
  }
  const host = url.hostname.toLowerCase();
  if (isBlockedIp(host)) {
    throw new EgressError('blocked-ip', `egress to internal/link-local address blocked: ${host}`);
  }
  const allow = toSet(opts.allowlist);
  if (allow && allow.size > 0 && !allow.has(host)) {
    throw new EgressError('not-allowlisted', `host not in outbound allowlist: ${host}`);
  }
  return url;
}
