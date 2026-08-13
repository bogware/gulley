import type { FindingSource, PiiCategory } from './types';

/**
 * A built-in detection pattern. Every `regex` uses the global flag and is
 * written to be linear-time (no nested unbounded quantifiers), so the built-ins
 * are ReDoS-safe against untrusted input without an RE2 dependency. Operator-
 * supplied *custom* regexes are the real ReDoS vector and should run under RE2;
 * that is a documented seam (see docs/ARCHITECTURE.md §guardrails), not wired here.
 */
export interface PatternDef {
  category: PiiCategory;
  source: FindingSource;
  regex: RegExp;
  confidence: number;
  /** Optional post-match validation (e.g. Luhn for card numbers). */
  validate?: (match: string) => boolean;
}

/** Luhn checksum — filters random 13–19 digit runs from real card numbers. */
export function luhnValid(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// Secret prefixes are matched before generic PII so a keyed token (e.g.
// `sk-ant-...`) is attributed to its issuer rather than a weaker pattern.
export const SECRET_PATTERNS: PatternDef[] = [
  {
    category: 'private_key',
    source: 'secret',
    regex:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
    confidence: 0.99,
  },
  {
    category: 'aws_access_key_id',
    source: 'secret',
    regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g,
    confidence: 0.95,
  },
  {
    category: 'github_token',
    source: 'secret',
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,251}\b/g,
    confidence: 0.98,
  },
  {
    category: 'anthropic_key',
    source: 'secret',
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,120}\b/g,
    confidence: 0.97,
  },
  {
    category: 'openai_key',
    source: 'secret',
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,120}\b/g,
    confidence: 0.9,
  },
  {
    category: 'slack_token',
    source: 'secret',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,120}\b/g,
    confidence: 0.95,
  },
  {
    category: 'google_api_key',
    source: 'secret',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    confidence: 0.9,
  },
  {
    category: 'jwt',
    source: 'secret',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    confidence: 0.85,
  },
];

export const PII_PATTERNS: PatternDef[] = [
  {
    category: 'email',
    source: 'pattern',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g,
    confidence: 0.97,
  },
  {
    category: 'ssn',
    source: 'pattern',
    // US SSN with separators; requires dashes/spaces to avoid matching any
    // 9-digit run. Excludes obvious invalids (000 area, 00 group, 0000 serial).
    regex: /\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/g,
    confidence: 0.8,
  },
  {
    category: 'credit_card',
    source: 'pattern',
    regex: /\b\d(?:[ -]?\d){12,18}\b/g,
    confidence: 0.9,
    validate: luhnValid,
  },
  {
    category: 'ip_address',
    source: 'pattern',
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
    confidence: 0.6,
  },
  {
    category: 'phone',
    source: 'pattern',
    // North-American / E.164-ish; deliberately conservative (dashes/spaces or
    // parens) so it does not swallow arbitrary digit runs.
    regex: /(?:\+?\d{1,3}[ -])?(?:\(\d{3}\)[ -]?|\d{3}[ -])\d{3}[ -]\d{4}\b/g,
    confidence: 0.5,
  },
];

export const NATIVE_PATTERNS: PatternDef[] = [...SECRET_PATTERNS, ...PII_PATTERNS];
