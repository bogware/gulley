import { shannonEntropy } from './entropy';
import { NATIVE_PATTERNS } from './patterns';
import type { Detector, Finding } from './types';

export interface NativeDetectorOptions {
  /** Enable the high-entropy catch-all for unkeyed secrets. Default true. */
  entropy?: boolean;
  /** Minimum bits/char for a token to count as high-entropy. Default 3.5. */
  minEntropyBits?: number;
  /** Minimum length of a token considered by the entropy pass. Default 24. */
  minEntropyLength?: number;
}

const ENTROPY_CANDIDATE = /[A-Za-z0-9+/=_-]{16,}/g;

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

  constructor(opts: NativeDetectorOptions = {}) {
    this.entropyOn = opts.entropy !== false;
    this.minBits = opts.minEntropyBits ?? 3.5;
    this.minLen = opts.minEntropyLength ?? 24;
  }

  detect(text: string): Finding[] {
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
