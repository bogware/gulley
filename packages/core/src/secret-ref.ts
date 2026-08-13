/**
 * A reference to a secret held externally (AWS Secrets Manager) — an ARN +
 * version, NEVER the value. Config, YAML exports, and audit diffs may carry a
 * SecretRef but never inline secret material; the serialization guard in
 * @gulley/pipeline enforces that at runtime and in a build-failing test.
 */
export const SECRET_REF = Symbol.for('gulley.secret_ref');

export interface SecretRef {
  readonly [SECRET_REF]: true;
  readonly secretArn: string;
  readonly secretVersion: string;
}

const SECRET_ARN_RE = /^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/;

export function isSecretArn(arn: string): boolean {
  return SECRET_ARN_RE.test(arn);
}

/** True if `v` structurally looks like a secret reference (arn + version). */
export function isSecretRefShape(v: unknown): v is { secretArn: string; secretVersion: string } {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o['secretArn'] === 'string' && typeof o['secretVersion'] === 'string';
}

/** Construct a validated SecretRef; throws on a malformed ARN or empty version. */
export function secretRef(secretArn: string, secretVersion: string): SecretRef {
  if (!isSecretArn(secretArn)) throw new Error(`invalid Secrets Manager ARN: ${secretArn}`);
  if (!secretVersion) throw new Error('secretVersion is required');
  return { [SECRET_REF]: true, secretArn, secretVersion };
}
