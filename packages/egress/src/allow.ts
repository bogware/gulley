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

/** True if `s` contains any control char, space, or DEL (code point <= 0x20 or 0x7f). */
function hasControlOrSpace(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * Validate a value destined to become ONE path segment of an upstream URL — e.g.
 * a client-supplied model id spliced into a Bedrock/Vertex path. Rejects path
 * separators, `..` traversal, and control/space characters, and re-checks the
 * decoded form so a percent-encoded `..%2f` cannot smuggle a traversal past the
 * caller's `encodeURIComponent`. Returns the value unchanged (the caller still
 * encodes it on write). The "decode-then-validate, encode-on-write" discipline.
 */
export function assertSafePathSegment(value: string, label = 'path segment'): string {
  if (!value || value.length > 256) {
    throw new EgressError('invalid-url', `${label} is empty or too long`);
  }
  const unsafe = (s: string): boolean =>
    hasControlOrSpace(s) || s.includes('/') || s.includes('\\') || s.includes('..');
  if (unsafe(value)) {
    throw new EgressError('invalid-url', `unsafe ${label}: ${JSON.stringify(value)}`);
  }
  if (value.includes('%')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      throw new EgressError('invalid-url', `undecodable ${label}: ${JSON.stringify(value)}`);
    }
    if (unsafe(decoded)) {
      throw new EgressError('invalid-url', `unsafe (encoded) ${label}: ${JSON.stringify(value)}`);
    }
  }
  return value;
}

/** True for any internal / link-local / metadata / loopback address literal. */
export function isBlockedIp(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    // Link-local is fe80::/10 (fe80–febf), not only the fe80 prefix; ULA fc00::/7.
    if (/^fe[89ab]/.test(h) || h.startsWith('fc') || h.startsWith('fd')) return true;
    // IPv4-compatible (::a.b.c.d, deprecated but parsed) and NAT64 (64:ff9b::/96)
    // embed an IPv4 address that must be checked as such.
    const compat = /^::(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (compat?.[1]) return isBlockedIp(compat[1]);
    // The WHATWG parser normalises ::169.254.169.254 to ::a9fe:a9fe (hex).
    const compatHex = /^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (compatHex?.[1] && compatHex[2] && compatHex[1] !== 'ffff') {
      const n = ((parseInt(compatHex[1], 16) << 16) | parseInt(compatHex[2], 16)) >>> 0;
      return isBlockedIp([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
    }
    const nat64 = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (nat64?.[1] && nat64[2]) {
      const n = ((parseInt(nat64[1], 16) << 16) | parseInt(nat64[2], 16)) >>> 0;
      return isBlockedIp([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
    }
    // IPv4-mapped IPv6, dotted form (::ffff:169.254.169.254).
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped?.[1]) return isBlockedIp(mapped[1]);
    // IPv4-mapped IPv6, HEX form — the form the WHATWG URL parser actually emits
    // (new URL('https://[::ffff:169.254.169.254]/').hostname === '[::ffff:a9fe:a9fe]').
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (hex?.[1] && hex[2]) {
      const n = ((parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16)) >>> 0;
      return isBlockedIp([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
    }
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

/** Names that always resolve to a local or metadata endpoint, whatever DNS says. */
export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === 'metadata.google.internal' ||
    h === 'metadata' ||
    h === 'instance-data' ||
    h === 'instance-data.ec2.internal'
  );
}

export interface EgressOptions {
  /** Exact, lowercased hostnames allowed. Empty/absent = allow any non-blocked host,
   *  UNLESS air-gapped (then an empty/absent allowlist denies all egress). */
  allowlist?: ReadonlySet<string> | readonly string[];
  /** Require https. Default true. */
  requireHttps?: boolean;
  /** Air-gapped posture: an empty/absent allowlist DENIES (fail-closed) instead of
   *  falling back to "allow any public host". Defaults to the process-wide setting
   *  ({@link setAirGappedEgress}); pass explicitly to override per call (e.g. tests). */
  airGapped?: boolean;
}

/** Process-wide air-gap default, set once at boot from the AIR_GAPPED config. When on,
 *  any guarded egress without an explicit allowlist is denied — so a deployment can't
 *  accidentally reach the public internet. Internal services reached via an
 *  `*_ALLOW_INTERNAL` bypass (which never calls this guard) are unaffected. */
let airGappedDefault = false;
export function setAirGappedEgress(on: boolean): void {
  airGappedDefault = on;
}
export function isAirGappedEgress(): boolean {
  return airGappedDefault;
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
  if (isBlockedIp(host) || isBlockedHostname(host)) {
    throw new EgressError('blocked-ip', `egress to internal/link-local address blocked: ${host}`);
  }
  const allow = toSet(opts.allowlist);
  const airGapped = opts.airGapped ?? airGappedDefault;
  if (airGapped && (!allow || allow.size === 0)) {
    throw new EgressError(
      'not-allowlisted',
      `air-gapped: egress to ${host} requires an explicit outbound allowlist`,
    );
  }
  if (allow && allow.size > 0 && !allow.has(host)) {
    throw new EgressError('not-allowlisted', `host not in outbound allowlist: ${host}`);
  }
  return url;
}
