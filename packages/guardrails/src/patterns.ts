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

/** Luhn checksum over the digits, restricted to [minLen, maxLen] digit runs. */
function luhn(value: string, minLen: number, maxLen: number): boolean {
  const digits = value.replace(/[^0-9]/g, '');
  if (digits.length < minLen || digits.length > maxLen) return false;
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

/** Luhn checksum — filters random 13–19 digit runs from real card numbers. */
export function luhnValid(value: string): boolean {
  return luhn(value, 13, 19);
}

/** Canadian SIN: exactly 9 digits and Luhn-valid (weeds out arbitrary 9-runs). */
export function sinValid(value: string): boolean {
  return luhn(value, 9, 9);
}

/**
 * Lightweight phone plausibility (a libphonenumber-lite): NANP numbers must have
 * valid area/exchange leading digits (2–9); other lengths are accepted as E.164
 * (8–15 digits, non-zero lead). Filters digit runs the shape-regex lets through.
 */
export function phonePlausible(match: string): boolean {
  const digits = match.replace(/\D/g, '');
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (local.length === 10) return /^[2-9]\d{2}[2-9]\d{6}$/.test(local);
  return digits.length >= 8 && digits.length <= 15 && !digits.startsWith('0');
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
    // parens) so it does not swallow arbitrary digit runs. Validated for NANP/E.164
    // plausibility to drop shape-matching-but-implausible runs.
    regex: /(?:\+?\d{1,3}[ -])?(?:\(\d{3}\)[ -]?|\d{3}[ -])\d{3}[ -]\d{4}\b/g,
    confidence: 0.5,
    validate: phonePlausible,
  },
  {
    category: 'ca_sin',
    source: 'pattern',
    // Canadian SIN: 9 digits in 3-3-3 groups; Luhn-checked so it does not fire on
    // arbitrary 9-digit runs. Weak on its own — context words boost it.
    regex: /\b\d{3}[- ]?\d{3}[- ]?\d{3}\b/g,
    confidence: 0.5,
    validate: sinValid,
  },
  {
    category: 'url',
    source: 'pattern',
    // http(s) URLs (may carry tokens / tracking params). Bounded, linear-time.
    regex: /\bhttps?:\/\/[^\s<>"'()]{3,2048}/g,
    confidence: 0.35,
  },
];

/** Context words that, when found near a match, raise its confidence — the
 *  "context-word boosting" that lets weak shape patterns be trusted in context
 *  (e.g. a 9-digit run beside "SIN") without over-firing elsewhere. */
export const CONTEXT_WORDS: Partial<Record<PiiCategory, RegExp>> = {
  ssn: /social security|\bssn\b/i,
  ca_sin: /social insurance|\bsin\b/i,
  credit_card: /\b(?:card|credit|debit|cc|visa|mastercard|amex)\b/i,
  phone: /\b(?:phone|mobile|cell|tel|call|fax|contact)\b/i,
  ip_address: /\b(?:ip|address|host|server|gateway)\b/i,
  email: /\b(?:e-?mail|contact)\b/i,
  url: /\b(?:url|link|href|site|visit|endpoint)\b/i,
};

export const NATIVE_PATTERNS: PatternDef[] = [...SECRET_PATTERNS, ...PII_PATTERNS];
