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

/**
 * Resolves a `SecretRef` (ARN + version) to its plaintext value — the ONLY place
 * a secret value materializes. Pluggable so the same code runs against AWS
 * Secrets Manager in prod and an in-process map in dev/tests. A resolution
 * failure must throw, so a config reconcile that can't resolve a credential
 * aborts atomically rather than pointing a live route at an empty secret.
 */
export interface SecretResolver {
  resolve(ref: { secretArn: string; secretVersion: string }): Promise<string>;
}

/** In-process resolver over an ARN→value map, for dev/tests. Throws on a miss. */
export class MapSecretResolver implements SecretResolver {
  constructor(private readonly values: ReadonlyMap<string, string>) {}
  async resolve(ref: { secretArn: string; secretVersion: string }): Promise<string> {
    const v = this.values.get(ref.secretArn);
    if (v === undefined) throw new Error(`no secret value for ${ref.secretArn}`);
    return v;
  }
}
