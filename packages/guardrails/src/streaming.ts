import { filterByPolicy } from './engine';
import type { Detector, Finding, GuardrailPolicy } from './types';
import { redactText, TokenVault } from './vault';

/**
 * Starts of a potentially-LONG match — one that can exceed the hold window, so the
 * detector can't recognize it until the whole thing has streamed (a multi-line PEM
 * private key, a long JWT). While such a start is present but its full match has
 * NOT yet been detected (still forming), {@link StreamingRedactor} holds from the
 * start so its leading bytes are never emitted before it completes; once the full
 * pattern IS detected the normal finding-redaction takes over, and if it never
 * completes within the buffer cap the redactor fails closed (withholds the rest)
 * rather than leak a prefix. Bounded-length matches are covered by the window.
 * `category` is the category the completed match would carry (so the anchor stops
 * holding once that finding appears — avoiding a hold/redact deadlock).
 */
const LONG_MATCH_ANCHORS: ReadonlyArray<{ start: RegExp; category: string }> = [
  { start: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g, category: 'private_key' },
  // A base64url header segment followed by a `.` — the structural start of a JWT.
  // Requiring the dot (not just an `eyJ...` run) avoids holding — and eventually
  // fail-closing — on an ordinary base64 blob that merely begins with `eyJ`.
  { start: /eyJ[A-Za-z0-9_-]{10,}\./g, category: 'jwt' },
];

/**
 * Largest suffix length of `text` (< maxLen) that is a strict prefix of some
 * token — i.e. text that might be the beginning of a token still arriving. That
 * suffix must be retained, not emitted, so a token is never split across chunks.
 */
export function partialTailLength(text: string, tokens: string[], maxLen: number): number {
  const upper = Math.min(maxLen - 1, text.length);
  for (let len = upper; len >= 1; len--) {
    const suffix = text.slice(text.length - len);
    for (const t of tokens) {
      if (t.length > len && t.startsWith(suffix)) return len;
    }
  }
  return 0;
}

/**
 * Windowed streaming replacer for known fixed tokens (used for detokenization).
 * Retains only a bounded tail that could be a partial token, so output is
 * byte-for-byte identical to replacing on the fully-buffered string.
 */
export class StreamingReplacer {
  private buffer = '';
  private readonly tokens: string[];
  private readonly map: Map<string, string>;
  private readonly maxLen: number;

  constructor(entries: Array<[string, string]>) {
    this.map = new Map(entries);
    this.tokens = entries.map(([t]) => t);
    this.maxLen = this.tokens.reduce((m, t) => Math.max(m, t.length), 0);
  }

  push(chunk: string): string {
    this.buffer += chunk;
    if (this.maxLen === 0) {
      const out = this.buffer;
      this.buffer = '';
      return out;
    }
    const keep = partialTailLength(this.buffer, this.tokens, this.maxLen);
    const emit = this.buffer.slice(0, this.buffer.length - keep);
    this.buffer = this.buffer.slice(this.buffer.length - keep);
    return this.replace(emit);
  }

  flush(): string {
    const out = this.replace(this.buffer);
    this.buffer = '';
    return out;
  }

  private replace(s: string): string {
    if (!s) return s;
    let out = s;
    for (const [token, original] of this.map) {
      if (out.includes(token)) out = out.split(token).join(original);
    }
    return out;
  }
}

/**
 * Windowed streaming detector for audit-only output guardrails: scans a rolling
 * buffer (retaining a tail so matches spanning chunk boundaries are caught),
 * accumulates de-duplicated findings by absolute offset, and never modifies the
 * text. Bound `windowChars` above the longest expected match.
 */
export class StreamingScanner {
  private overlap = '';
  private base = 0;
  private readonly window: number;
  private readonly maxBuffer: number;
  private readonly seen = new Map<string, Finding>();

  constructor(
    private readonly detector: Detector,
    windowChars = 1024,
  ) {
    this.window = windowChars;
    // Room for a forming long secret (a multi-line PEM key) to complete before the
    // anchor-hold is released; beyond this it is recorded as a possible truncated secret.
    this.maxBuffer = Math.max(this.window * 8, 8192);
  }

  push(chunk: string): void {
    const text = this.overlap + chunk;
    const raw = this.detector.detect(text);
    for (const f of raw) {
      const absStart = this.base + f.start;
      const key = `${absStart}:${f.category}`;
      if (!this.seen.has(key)) {
        this.seen.set(key, { ...f, start: absStart, end: this.base + f.end });
      }
    }
    // Normally retain a flat `window` tail. But if a LONG-match anchor (a PEM/JWT start)
    // has appeared WITHOUT its full match completing, retain from that anchor instead —
    // else a secret longer than the window loses its opening bytes from the overlap
    // before the closing bytes arrive, so detect() never sees BEGIN and END together and
    // the leak is NEVER recorded (a SOC 2 audit-completeness gap for the worst leak
    // class). The scanner is a passive observer, so this holds only its OWN state — the
    // client-bound bytes are piped separately and are unaffected.
    let keepFrom = Math.max(0, text.length - this.window);
    let heldCategory: string | undefined;
    for (const { start, category } of LONG_MATCH_ANCHORS) {
      start.lastIndex = 0;
      for (let m = start.exec(text); m !== null; m = start.exec(text)) {
        if (m[0].length === 0) {
          start.lastIndex++;
          continue;
        }
        const idx = m.index;
        const complete = raw.some((f) => f.category === category && f.start <= idx && f.end > idx);
        if (!complete && idx < keepFrom) {
          keepFrom = idx;
          heldCategory = category;
        }
      }
    }
    // A held anchor that never completes must not grow memory without bound: on overflow
    // record a (lower-confidence) finding under its category so the audit trail still
    // reflects a possible truncated secret, then release the hold to the window tail.
    if (heldCategory && text.length - keepFrom > this.maxBuffer) {
      const key = `${this.base + keepFrom}:${heldCategory}`;
      if (!this.seen.has(key)) {
        this.seen.set(key, {
          category: heldCategory as Finding['category'],
          start: this.base + keepFrom,
          end: this.base + text.length,
          source: 'secret',
          confidence: 0.5,
        });
      }
      keepFrom = Math.max(0, text.length - this.window);
    }
    this.base += keepFrom;
    this.overlap = text.slice(keepFrom);
  }

  findings(): Finding[] {
    return [...this.seen.values()].sort((a, b) => a.start - b.start);
  }
}

/**
 * Windowed streaming ENFORCER for output guardrails (M17) — the mutate-and-emit
 * analogue of {@link StreamingScanner}, over LOGICAL text (not raw SSE bytes).
 *
 * `push(chunk)` holds back a `windowChars` tail (so a match forming at a chunk
 * boundary is never split), pulls that boundary earlier so no enforceable
 * finding straddles it, then replaces the findings fully inside the safe prefix
 * and emits: a `redact` policy substitutes the irreversible `<<REDACTED_CAT>>`
 * placeholder; a `mask` policy substitutes a reversible per-value token via a
 * stream-long {@link TokenVault} (recurring values keep one token — coreference
 * preserved — and the emitted stream detokenizes back to the original via
 * {@link vault}). A `block` policy emits the clean content up to the first
 * enforceable finding, sets {@link blocked}, and stops. `flush()` handles the
 * residual at stream end.
 *
 * Guarantee (mirrors {@link StreamingReplacer}): for a `redact` policy the
 * concatenation of all `push`+`flush` output equals `redactText` applied to the
 * fully-buffered logical body, for any chunk boundaries; for a `mask` policy that
 * concatenation detokenizes (via {@link vault}) back to the fully-buffered body,
 * with no raw sensitive value ever emitted. `findings()` returns the
 * de-duplicated absolute-offset findings for the audit trail. The hold buffer is
 * byte-capped: an open-ended match that keeps pulling the boundary back trips
 * {@link failClosed} so the caller withholds the rest rather than emit unenforced
 * bytes. `windowChars` covers bounded matches; effectively-unbounded ones (a
 * multi-line PEM private key, a long JWT) are held from their start anchor (see
 * {@link LONG_MATCH_ANCHORS}) so their leading bytes are never leaked before the
 * match completes, regardless of window size.
 */
export class StreamingRedactor {
  private buffer = '';
  private base = 0;
  private readonly seen = new Map<string, Finding>();
  private _blocked = false;
  private _failClosed = false;
  private readonly window: number;
  private readonly maxBuffer: number;
  private readonly block: boolean;
  private readonly _vault?: TokenVault;
  private readonly anchors: ReadonlyArray<{ start: RegExp; category: string }>;

  constructor(
    private readonly detector: Detector,
    private readonly policy: GuardrailPolicy,
    windowChars = 512,
  ) {
    this.window = Math.max(1, windowChars);
    // Room for a forming long match (a PEM private key) to complete and be redacted
    // in full; beyond this it fails closed (withheld) rather than leaked.
    this.maxBuffer = Math.max(this.window * 8, 8192);
    this.block = policy.action === 'block';
    // `mask` tokenizes reversibly (stable per-value token, restorable via the vault);
    // `redact` (and any other action) replaces irreversibly. One vault spans the
    // whole stream so a value recurring across chunks keeps its token (coreference).
    this._vault = policy.action === 'mask' ? new TokenVault() : undefined;
    // Only hold an anchor whose category this policy could enforce. Under a policy
    // that excludes the category (e.g. mask PII only, not secrets), a matching
    // JWT/PEM is not sensitive — holding it would add latency for nothing. The
    // `minConfidence`-excluded case is handled separately by checking anchor
    // completion against the RAW (unfiltered) detector findings in process().
    const cats = policy.categories;
    this.anchors = cats
      ? LONG_MATCH_ANCHORS.filter((a) => cats.includes(a.category))
      : LONG_MATCH_ANCHORS;
  }

  /** A `block` policy hit an enforceable finding; the caller terminates the stream. */
  get blocked(): boolean {
    return this._blocked;
  }
  /** The hold buffer overflowed (open-ended match); withhold the rest (fail closed). */
  get failClosed(): boolean {
    return this._failClosed;
  }
  /** For a `mask` policy: the reversible token↔original map accumulated over the
   *  stream (so an authorized consumer can detokenize). Undefined for other actions. */
  get vault(): TokenVault | undefined {
    return this._vault;
  }

  push(chunk: string): string {
    if (this._blocked || this._failClosed) return ''; // terminal — emit nothing more
    this.buffer += chunk;
    return this.process(false);
  }

  flush(): string {
    if (this._blocked || this._failClosed) return '';
    return this.process(true);
  }

  private process(final: boolean): string {
    const raw = this.detector.detect(this.buffer);
    const findings = filterByPolicy(raw, this.policy);
    // Record every detected finding once (absolute offsets), like StreamingScanner —
    // the audit trail teardown reads. redactText is not offset-idempotent, so this
    // de-dup is also what prevents a re-seen span being redacted/counted twice.
    for (const f of findings) {
      const key = `${this.base + f.start}:${f.category}`;
      if (!this.seen.has(key)) {
        this.seen.set(key, { ...f, start: this.base + f.start, end: this.base + f.end });
      }
    }

    // Safe-emit boundary: hold a window tail (unless flushing) and never emit the
    // leading bytes of a finding that extends past that boundary.
    const windowEnd = final ? this.buffer.length : Math.max(0, this.buffer.length - this.window);
    let safeEnd = windowEnd;
    if (!final) {
      for (const f of findings) {
        if (f.end > windowEnd) safeEnd = Math.min(safeEnd, f.start);
      }
      // Also hold from the start of any FORMING long match (see LONG_MATCH_ANCHORS):
      // detection needs the whole match, so without this a match longer than the
      // window would leak its leading bytes before it completes. Completion is
      // judged against the RAW (unfiltered) detector findings — a detector-
      // recognition question, independent of the policy filter — so a match the
      // policy will NOT enforce (below `minConfidence`) still releases when the
      // detector recognizes it (then emits un-redacted) instead of deadlocking the
      // hold into a fail-closed. `this.anchors` already drops categories outside the
      // policy's `categories` scope. A match that never completes grows the buffer →
      // failClosed (withheld, not leaked).
      for (const { start, category } of this.anchors) {
        start.lastIndex = 0;
        for (let m = start.exec(this.buffer); m !== null; m = start.exec(this.buffer)) {
          if (m[0].length === 0) {
            start.lastIndex++;
            continue;
          }
          const idx = m.index;
          const complete = raw.some(
            (f) => f.category === category && f.start <= idx && f.end > idx,
          );
          if (!complete) safeEnd = Math.min(safeEnd, idx);
        }
      }
    }

    if (this.block) {
      const first = findings.find((f) => f.end <= safeEnd);
      if (first) {
        this._blocked = true;
        const out = this.buffer.slice(0, first.start); // clean content before the violation
        this.buffer = '';
        return out;
      }
    }

    const prefix = this.buffer.slice(0, safeEnd);
    const enforceable = findings.filter((f) => f.end <= safeEnd);
    const emitted = this.block
      ? prefix
      : this._vault
        ? this._vault.tokenize(prefix, enforceable) // reversible mask
        : redactText(prefix, enforceable); // irreversible redact
    this.buffer = this.buffer.slice(safeEnd);
    this.base += safeEnd;

    if (!final && this.buffer.length > this.maxBuffer) this._failClosed = true;
    return emitted;
  }

  findings(): Finding[] {
    return [...this.seen.values()].sort((a, b) => a.start - b.start);
  }
}
