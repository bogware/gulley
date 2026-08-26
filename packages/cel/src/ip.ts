/** Minimal IPv4 CIDR support for the CEL `ip()` / `cidr(x).containsIP(y)`
 *  helpers — enough for source-IP authorization rules. IPv6 is out of scope. */
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split('.');
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

export interface Cidr {
  base: number;
  bits: number;
}

export function parseCidr(cidr: string): Cidr | null {
  const [ip, bitsRaw] = cidr.trim().split('/');
  const base = ip ? ipv4ToInt(ip) : null;
  if (base === null) return null;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  return { base, bits };
}

export function cidrContains(cidr: Cidr, ip: string): boolean {
  const addr = ipv4ToInt(ip);
  if (addr === null) return false;
  const mask = cidr.bits === 0 ? 0 : (0xffffffff << (32 - cidr.bits)) >>> 0;
  return (addr & mask) === (cidr.base & mask);
}
