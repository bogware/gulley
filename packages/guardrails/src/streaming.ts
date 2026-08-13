import type { Detector, Finding } from './types';

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
  private readonly seen = new Map<string, Finding>();

  constructor(
    private readonly detector: Detector,
    windowChars = 1024,
  ) {
    this.window = windowChars;
  }

  push(chunk: string): void {
    const text = this.overlap + chunk;
    for (const f of this.detector.detect(text)) {
      const absStart = this.base + f.start;
      const key = `${absStart}:${f.category}`;
      if (!this.seen.has(key)) {
        this.seen.set(key, { ...f, start: absStart, end: this.base + f.end });
      }
    }
    if (text.length > this.window) {
      this.base += text.length - this.window;
      this.overlap = text.slice(text.length - this.window);
    } else {
      this.overlap = text;
    }
  }

  findings(): Finding[] {
    return [...this.seen.values()].sort((a, b) => a.start - b.start);
  }
}
