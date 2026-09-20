import { randomBytes } from 'node:crypto';
import type { Finding } from './types';

/** Token format is JSON-safe (no quotes, backslashes, or control characters) so
 *  a masked value can be spliced into a JSON request body without breaking it,
 *  and survives verbatim if the model echoes it back for detokenization. */
function tokenCategory(category: string): string {
  return category.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * Per-request reversible tokenization. `tokenize` swaps each detected span for a
 * stable sentinel token (identical originals share a token, so the model sees a
 * consistent placeholder); `detokenize` restores originals wherever the tokens
 * survive in the response. The map is request-scoped and never persisted.
 */
export class TokenVault {
  private readonly byOriginal = new Map<string, string>();
  private readonly byToken = new Map<string, string>();
  private counter = 0;
  /** Per-vault random namespace. Without it every request minted the same
   *  `<<GULLEY_EMAIL_1>>`: in a multi-turn agent loop turn 1's masked reply came
   *  back as history in turn 2, whose own vault reused the token for a DIFFERENT
   *  value — the model saw two entities behind one placeholder and the detokenizer
   *  rewrote turn 1's token to turn 2's original (wrong PII substituted). */
  private readonly nonce = randomBytes(4).toString('hex').toUpperCase();

  private tokenFor(category: string, original: string): string {
    const existing = this.byOriginal.get(original);
    if (existing) return existing;
    const token = `<<GULLEY_${tokenCategory(category)}_${this.nonce}_${++this.counter}>>`;
    this.byOriginal.set(original, token);
    this.byToken.set(token, original);
    return token;
  }

  /** Replace each finding's span with a token, right-to-left so offsets stay
   *  valid. Offsets are indices into `text`. */
  tokenize(text: string, findings: Finding[]): string {
    const sorted = [...findings].sort((a, b) => b.start - a.start);
    let out = text;
    for (const f of sorted) {
      const original = text.slice(f.start, f.end);
      const token = this.tokenFor(f.category, original);
      out = out.slice(0, f.start) + token + out.slice(f.end);
    }
    return out;
  }

  detokenize(text: string): string {
    let out = text;
    for (const [token, original] of this.byToken) {
      if (out.includes(token)) out = out.split(token).join(original);
    }
    return out;
  }

  /** The token→original map — the ONLY state needed to reverse a mask later. The
   *  `original` values are the RAW detected secrets/PII, so a caller that persists
   *  this MUST envelope-encrypt it first (never store or log it in cleartext). */
  entries(): Array<[string, string]> {
    return [...this.byToken];
  }

  get size(): number {
    return this.byToken.size;
  }

  /** Reconstruct a vault from a persisted (decrypted) {@link entries} map so a
   *  masked response can be de-tokenized later by an authorized consumer. */
  static fromEntries(entries: ReadonlyArray<readonly [string, string]>): TokenVault {
    const v = new TokenVault();
    for (const [token, original] of entries) {
      v.byToken.set(token, original);
      v.byOriginal.set(original, token);
    }
    return v;
  }
}

/** Irreversible replacement: each span becomes a category placeholder with no
 *  stored mapping. Used by the `redact` action. */
export function redactText(text: string, findings: Finding[]): string {
  const sorted = [...findings].sort((a, b) => b.start - a.start);
  let out = text;
  for (const f of sorted) {
    out =
      out.slice(0, f.start) +
      `<<REDACTED_${tokenCategory(String(f.category))}>>` +
      out.slice(f.end);
  }
  return out;
}
