import { shannonEntropy } from './entropy';
import { CONTEXT_WORDS, NATIVE_PATTERNS } from './patterns';
import type { Detector, Finding, PiiCategory } from './types';

export interface NativeDetectorOptions {
  /** Enable the high-entropy catch-all for unkeyed secrets. Default true. */
  entropy?: boolean;
  /** Minimum bits/char for a token to count as high-entropy. Default 3.5. */
  minEntropyBits?: number;
  /** Minimum length of a token considered by the entropy pass. Default 24. */
  minEntropyLength?: number;
  /** Raise a finding's confidence when a category context word sits nearby
   *  (e.g. "SSN" beside a 9-digit run). Default true. */
  contextBoost?: boolean;
  /** Cap on the bytes actually scanned per call. The built-in patterns are linear,
   *  but a hostile body of millions of secret-marker anchors (up to the 32 MiB request
   *  limit) still costs `anchors × gap` work — real, if no longer quadratic. Scanning
   *  only a bounded prefix caps that worst case; the tradeoff is a documented DLP
   *  false-negative for secrets past the cap in an unusually large body. Default 4 MiB;
   *  legitimate content is far smaller and only pathological inputs are ever truncated.
   *  The complete fix (linear regardless of input) is RE2 — a documented seam. */
  maxScanBytes?: number;
}

const DEFAULT_MAX_SCAN_BYTES = 4 * 1024 * 1024;

const ENTROPY_CANDIDATE = /[A-Za-z0-9+/=_-]{16,}/g;

// Context-word boosting: a match near a category keyword is more likely genuine.
const CTX_BEFORE = 48;
const CTX_AFTER = 24;
const CTX_BOOST = 0.2;
const CTX_MAX = 0.98;

/** Boost (in place) the confidence of findings that sit near a context word for
 *  their category. Mutates before overlap resolution so a boosted weak finding
 *  can win its span. */
export function applyContextBoost(text: string, findings: Finding[]): void {
  for (const f of findings) {
    const rx = CONTEXT_WORDS[f.category as PiiCategory];
    if (!rx) continue;
    const before = text.slice(Math.max(0, f.start - CTX_BEFORE), f.start);
    const after = text.slice(f.end, f.end + CTX_AFTER);
    if (rx.test(before) || rx.test(after)) {
      f.confidence = Math.min(CTX_MAX, f.confidence + CTX_BOOST);
    }
  }
}

/**
 * The native, in-process detector: bounded-regex patterns + secret-prefix
 * scanning + an entropy catch-all, with overlaps resolved so each character is
 * attributed to at most one (highest-confidence) finding.
 */
export class NativeDetector implements Detector {
  readonly name = 'native';
  private readonly entropyOn: boolean;
  private readonly minBits: number;
  private readonly minLen: number;
  private readonly contextBoost: boolean;
  private readonly maxScanBytes: number;

  constructor(opts: NativeDetectorOptions = {}) {
    this.entropyOn = opts.entropy !== false;
    this.minBits = opts.minEntropyBits ?? 3.5;
    this.minLen = opts.minEntropyLength ?? 24;
    this.contextBoost = opts.contextBoost !== false;
    this.maxScanBytes = opts.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES;
  }

  detect(full: string): Finding[] {
    // Bound the scanned text so a pathological body can't drive unbounded regex work
    // (offsets stay valid — the scan is a prefix, so start/end index the original).
    const text = full.length > this.maxScanBytes ? full.slice(0, this.maxScanBytes) : full;
    const raw: Finding[] = [];

    for (const def of NATIVE_PATTERNS) {
      def.regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = def.regex.exec(text)) !== null) {
        const value = m[0];
        if (value.length === 0) {
          def.regex.lastIndex++;
          continue;
        }
        if (!def.validate || def.validate(value)) {
          raw.push({
            category: def.category,
            start: m.index,
            end: m.index + value.length,
            source: def.source,
            confidence: def.confidence,
          });
        }
      }
    }

    if (this.entropyOn) {
      ENTROPY_CANDIDATE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ENTROPY_CANDIDATE.exec(text)) !== null) {
        const value = m[0];
        if (value.length >= this.minLen && shannonEntropy(value) >= this.minBits) {
          raw.push({
            category: 'high_entropy',
            start: m.index,
            end: m.index + value.length,
            source: 'entropy',
            confidence: 0.4,
          });
        }
      }
    }

    if (this.contextBoost) applyContextBoost(text, raw);
    return resolveOverlaps(raw);
  }
}

/**
 * Greedily keep the highest-confidence finding for any overlapping span, so a
 * keyed secret wins over the entropy catch-all and no character is masked twice.
 * Returned findings are sorted by start offset.
 */
export function resolveOverlaps(findings: Finding[]): Finding[] {
  const byConfidence = [...findings].sort(
    (a, b) => b.confidence - a.confidence || b.end - b.start - (a.end - a.start),
  );
  const kept: Finding[] = [];
  for (const f of byConfidence) {
    if (!kept.some((k) => f.start < k.end && k.start < f.end)) kept.push(f);
  }
  return kept.sort((a, b) => a.start - b.start);
}
