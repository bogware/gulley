import { isSecretArn, isSecretRefShape } from '@gulley/core';
import type { AuditEventInput, AuditRow, AuditSink } from './audit';

export const REDACTED = '[REDACTED]';

/** Field names that must never hold an inline secret value (only a SecretRef,
 *  or a redacted marker). Matched case-insensitively as a substring. */
const SECRET_KEY_RE =
  /(secret|password|passwd|pepper|privatekey|private_key|keyhash|key_hash|refreshtoken|refresh_token|apikey|api_key|access_token|accesstoken|client_secret|clientsecret|credentialvalue)/i;

// Known, unambiguous secret token formats. Deliberately NOT generic long-hex —
// legitimate audit fields carry sha256 hashes (rowHash/prevHash/contentHash).
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN (?:[A-Z ]*)?PRIVATE KEY-----/,
];

export function looksLikeSecretMaterial(s: string): boolean {
  return SECRET_VALUE_PATTERNS.some((re) => re.test(s));
}

function isValidSecretRef(v: unknown): boolean {
  return isSecretRefShape(v) && isSecretArn(v.secretArn);
}

export function isSecretRef(v: unknown): boolean {
  return isValidSecretRef(v);
}

export class InlineSecretError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`inline secret at ${path}: ${detail}`);
    this.name = 'InlineSecretError';
  }
}

/**
 * Throw if `value` carries any inline secret material: a value in a known secret
 * format anywhere, or a secret-NAMED field holding a raw (non-SecretRef) value.
 * A well-formed SecretRef ({secretArn, secretVersion}) is the only allowed
 * secret-bearing shape. This is the ARCH §6 build-failing guard.
 */
export function assertNoInlineSecret(value: unknown, path = '$'): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (looksLikeSecretMaterial(value)) {
      throw new InlineSecretError(path, 'value matches a known secret format');
    }
    return;
  }
  if (typeof value !== 'object') return;

  if (isSecretRefShape(value)) {
    if (isSecretArn(value.secretArn)) return; // allowed; do not recurse into the ref
    throw new InlineSecretError(`${path}.secretArn`, 'secret reference has a non-ARN value');
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoInlineSecret(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k) && !isValidSecretRef(v)) {
      if (typeof v === 'string' && v !== REDACTED) {
        throw new InlineSecretError(`${path}.${k}`, 'secret-named field holds an inline value');
      }
    }
    assertNoInlineSecret(v, `${path}.${k}`);
  }
}

/** Non-throwing redaction: secret-format values and secret-named scalar fields
 *  become [REDACTED]; valid SecretRefs are kept intact. Used by the runtime sink
 *  so a false positive never punctures the audit chain. */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return looksLikeSecretMaterial(value) ? REDACTED : value;
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    if (isValidSecretRef(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) && typeof v !== 'object' ? REDACTED : redactValue(v);
    }
    return out;
  }
  return value;
}

export function redactAuditRow(payload: Record<string, unknown>): Record<string, unknown> {
  return redactValue(payload) as Record<string, unknown>;
}

/**
 * Wraps an AuditSink and redacts every payload before it is appended — the
 * always-on runtime backstop for ARCH §6 (never drop, never throw, never 500).
 * Increments a violation counter when a redaction actually fired.
 */
export class GuardedAuditSink implements AuditSink {
  violations = 0;

  constructor(
    private readonly inner: AuditSink,
    private readonly onViolation?: (event: AuditEventInput) => void,
  ) {}

  async append(event: AuditEventInput): Promise<AuditRow> {
    if (!event.payload) return this.inner.append(event);
    const redacted = redactAuditRow(event.payload);
    if (JSON.stringify(redacted) !== JSON.stringify(event.payload)) {
      this.violations++;
      this.onViolation?.(event);
    }
    return this.inner.append({ ...event, payload: redacted });
  }
}
