import { createHmac, randomBytes } from 'node:crypto';
import type { Finding } from './types';

/** Token format is JSON-safe (no quotes, backslashes, or control characters) so
 *  a masked value can be spliced into a JSON request body without breaking it,
 *  and survives verbatim if the model echoes it back for detokenization. */
function tokenCategory(category: string): string {
  return category.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/** Every token this module has ever minted matches this (either derivation). A
 *  detector finding that overlaps one of these spans is a token being re-scanned
 *  on a later turn (or by the entropy catch-all), never new PII — `tokenize`
 *  leaves it alone so a placeholder is never masked twice. */
export const MASK_TOKEN_RE = /<<GULLEY_[A-Z0-9_]+>>/g;

/** Minimum key length for a deterministic vault (128 bits of HMAC key). */
const MIN_KEY_BYTES = 16;
/** Hex characters of the HMAC kept in a token: 96 bits — the same width as the
 *  random per-vault nonce, so collisions are as unlikely as before. */
const TOKEN_HEX = 24;

export interface TokenVaultOptions {
  /** A per-CONVERSATION secret (see {@link deriveVaultKey}). With a key, a value
   *  always maps to the same token under that key — on every turn, in every
   *  replica, in both directions — so the masked request prefix is identical
   *  turn after turn (prompt caching and preserved-thinking prefix checks keep
   *  working). Without a key the vault is request-scoped: a random nonce
   *  namespaces its tokens so two vaults never share one. */
  key?: Uint8Array;
}

/**
 * Reversible tokenization. `tokenize` swaps each detected span for a stable
 * sentinel token (identical originals share a token, so the model sees a
 * consistent placeholder); `detokenize` restores originals wherever the tokens
 * survive in the response. The map is in-memory; a host that persists it must
 * envelope-encrypt it first ({@link entries}).
 *
 * Two derivations:
 * - **keyed (conversation-stable)**: `<<GULLEY_<CAT>_<24 hex of HMAC-SHA256(key, cat‖value)>>>`
 * - **keyless (request-scoped)**: `<<GULLEY_<CAT>_<24 hex random nonce>_<n>>>`
 *
 * The keyless nonce exists because without it every request minted the same
 * `<<GULLEY_EMAIL_1>>`: in a multi-turn agent loop turn 1's masked reply came back
 * as history in turn 2, whose own vault reused the token for a DIFFERENT value —
 * the model saw two entities behind one placeholder and the detokenizer rewrote
 * turn 1's token to turn 2's original (wrong PII substituted). The keyed form
 * solves the same problem the other way round: the token IS a function of the
 * value, so turn 2 re-derives turn 1's token for turn 1's value.
 */
export class TokenVault {
  private readonly byOriginal = new Map<string, string>();
  private readonly byToken = new Map<string, string>();
  private counter = 0;
  private readonly key?: Buffer;
  private readonly nonce?: string;

  constructor(options: TokenVaultOptions = {}) {
    if (options.key !== undefined) {
      if (options.key.byteLength < MIN_KEY_BYTES) {
        throw new Error(`TokenVault key must be at least ${MIN_KEY_BYTES} bytes`);
      }
      this.key = Buffer.from(options.key);
    } else {
      this.nonce = randomBytes(12).toString('hex').toUpperCase();
    }
  }

  /** True when tokens are derived from the conversation key (stable across
   *  requests), false when they are namespaced by a per-vault random nonce. */
  get deterministic(): boolean {
    return this.key !== undefined;
  }

  private tokenFor(category: string, original: string): string {
    const existing = this.byOriginal.get(original);
    if (existing) return existing;
    const cat = tokenCategory(category);
    const token = this.key
      ? `<<GULLEY_${cat}_${createHmac('sha256', this.key)
          .update(cat)
          .update('\u0000')
          .update(original, 'utf8')
          .digest('hex')
          .slice(0, TOKEN_HEX)
          .toUpperCase()}>>`
      : `<<GULLEY_${cat}_${this.nonce}_${++this.counter}>>`;
    this.byOriginal.set(original, token);
    this.byToken.set(token, original);
    return token;
  }

  /** Replace each finding's span with a token, right-to-left so offsets stay
   *  valid. Offsets are indices into `text`. Findings that overlap an existing
   *  `<<GULLEY_…>>` token (a placeholder echoed back in the history) are skipped. */
  tokenize(text: string, findings: Finding[]): string {
    const spans = existingTokenSpans(text);
    const sorted = [...findings]
      .filter((f) => !overlapsAny(f.start, f.end, spans))
      .sort((a, b) => b.start - a.start);
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
   *  masked response can be de-tokenized later by an authorized consumer. Pass the
   *  same `key` to keep tokenizing new values consistently with the restored ones. */
  static fromEntries(
    entries: ReadonlyArray<readonly [string, string]>,
    options: TokenVaultOptions = {},
  ): TokenVault {
    const v = new TokenVault(options);
    for (const [token, original] of entries) {
      v.byToken.set(token, original);
      v.byOriginal.set(original, token);
    }
    return v;
  }
}

function existingTokenSpans(text: string): Array<[number, number]> {
  if (!text.includes('<<GULLEY_')) return [];
  const spans: Array<[number, number]> = [];
  for (const m of text.matchAll(MASK_TOKEN_RE)) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

function overlapsAny(start: number, end: number, spans: Array<[number, number]>): boolean {
  for (const [s, e] of spans) if (start < e && end > s) return true;
  return false;
}

/** Derive the per-conversation vault key from a deployment master secret:
 *  `HMAC-SHA256(master, "gulley-mask-vault-v1" ‖ 0x00 ‖ scope)`. `scope` must
 *  name the tenant AND the conversation (e.g. `${workspaceId}\u0000${conversationId}`)
 *  so the same value in two workspaces never shares a token. The master is any
 *  ≥16-byte secret shared by every replica (the gateway uses its key pepper). */
export function deriveVaultKey(master: Uint8Array | string, scope: string): Buffer {
  const m = typeof master === 'string' ? Buffer.from(master, 'utf8') : Buffer.from(master);
  if (m.byteLength < MIN_KEY_BYTES) {
    throw new Error(`vault master secret must be at least ${MIN_KEY_BYTES} bytes`);
  }
  return createHmac('sha256', m)
    .update('gulley-mask-vault-v1\u0000')
    .update(scope, 'utf8')
    .digest();
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
