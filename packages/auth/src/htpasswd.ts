import { createHash, timingSafeEqual } from 'node:crypto';
import { compareSync } from 'bcryptjs';

/**
 * htpasswd verification for HTTP Basic inbound auth. Supports the formats
 * `htpasswd(1)` emits — bcrypt (`$2a/2b/2y$`, the modern default), Apache MD5
 * (`$apr1$`), SHA-1 (`{SHA}` / salted `{SSHA}`), and plaintext — so an operator
 * can front the gateway with a standard htpasswd file. DES `crypt` is
 * deliberately unsupported (13-char hashes are insecure and ambiguous).
 */

/** Parse an htpasswd file body into a `user → hash` map. Blank lines and `#`
 *  comments are skipped; the hash is everything after the first colon. */
export function parseHtpasswd(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    out.set(line.slice(0, idx), line.slice(idx + 1));
  }
  return out;
}

/** Constant-time string compare that does not short-circuit on length. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // Compare fixed-width digests so unequal lengths don't leak via early return.
  const ah = createHash('sha256').update(ab).digest();
  const bh = createHash('sha256').update(bb).digest();
  return timingSafeEqual(ah, bh) && ab.length === bb.length;
}

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function to64(value: number, count: number): string {
  let v = value;
  let s = '';
  for (let i = 0; i < count; i++) {
    s += ITOA64[v & 0x3f];
    v >>= 6;
  }
  return s;
}

const md5 = (...parts: Buffer[]): Buffer => {
  const h = createHash('md5');
  for (const p of parts) h.update(p);
  return h.digest();
};

/** Apache's `$apr1$` MD5 crypt (a.k.a. md5crypt with the `$apr1$` magic). */
export function apr1(password: string, salt: string): string {
  const magic = '$apr1$';
  const pw = Buffer.from(password, 'utf8');
  const saltBuf = Buffer.from(salt, 'utf8');

  const alt = md5(pw, saltBuf, pw);

  const ctx = createHash('md5');
  ctx.update(pw);
  ctx.update(Buffer.from(magic, 'utf8'));
  ctx.update(saltBuf);
  for (let i = pw.length; i > 0; i -= 16) ctx.update(alt.subarray(0, Math.min(16, i)));
  for (let i = pw.length; i > 0; i >>= 1) {
    ctx.update(i & 1 ? Buffer.from([0]) : pw.subarray(0, 1));
  }
  let digest = ctx.digest();

  for (let i = 0; i < 1000; i++) {
    const c = createHash('md5');
    c.update(i & 1 ? pw : digest);
    if (i % 3) c.update(saltBuf);
    if (i % 7) c.update(pw);
    c.update(i & 1 ? digest : pw);
    digest = c.digest();
  }

  const d = digest;
  const b = (x: number): number => d[x] as number;
  const encoded =
    to64((b(0) << 16) | (b(6) << 8) | b(12), 4) +
    to64((b(1) << 16) | (b(7) << 8) | b(13), 4) +
    to64((b(2) << 16) | (b(8) << 8) | b(14), 4) +
    to64((b(3) << 16) | (b(9) << 8) | b(15), 4) +
    to64((b(4) << 16) | (b(10) << 8) | b(5), 4) +
    to64(b(11), 2);
  return `${magic}${salt}$${encoded}`;
}

/** Verify a password against one htpasswd hash entry. Unknown/DES formats fail. */
export function verifyPassword(hash: string, password: string): boolean {
  if (/^\$2[abxy]\$/.test(hash)) {
    // $2x/$2y are algorithmically identical to $2b; normalize so bcryptjs accepts them.
    const normalized = hash.replace(/^\$2[xy]\$/, '$2b$');
    try {
      return compareSync(password, normalized);
    } catch {
      return false;
    }
  }
  if (hash.startsWith('$apr1$')) {
    const parts = hash.split('$'); // ['', 'apr1', salt, digest]
    const salt = parts[2];
    if (!salt) return false;
    return safeEqual(apr1(password, salt), hash);
  }
  if (hash.startsWith('{SHA}')) {
    const digest = createHash('sha1').update(password, 'utf8').digest('base64');
    return safeEqual(`{SHA}${digest}`, hash);
  }
  if (hash.startsWith('{SSHA}')) {
    const blob = Buffer.from(hash.slice('{SSHA}'.length), 'base64');
    if (blob.length <= 20) return false;
    const salt = blob.subarray(20);
    const expected = createHash('sha1').update(Buffer.from(password, 'utf8')).update(salt).digest();
    return (
      expected.length === blob.subarray(0, 20).length &&
      timingSafeEqual(expected, blob.subarray(0, 20))
    );
  }
  // Plaintext (with or without an explicit {plain} marker).
  const plain = hash.startsWith('{plain}') ? hash.slice('{plain}'.length) : hash;
  return safeEqual(plain, password);
}
