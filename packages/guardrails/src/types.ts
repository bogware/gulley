/**
 * A category of sensitive data. Built-in categories cover common PII and
 * secret material; plugins may emit their own category strings.
 */
export type PiiCategory =
  | 'email'
  | 'phone'
  | 'ssn'
  | 'ca_sin'
  | 'credit_card'
  | 'ip_address'
  | 'url'
  | 'aws_access_key_id'
  | 'github_token'
  | 'openai_key'
  | 'anthropic_key'
  | 'slack_token'
  | 'google_api_key'
  | 'private_key'
  | 'jwt'
  | 'high_entropy';

/** Which detector produced a finding. */
export type FindingSource = 'pattern' | 'secret' | 'entropy' | 'plugin';

/** A single detected span of sensitive data. Offsets are UTF-16 indices into
 *  the scanned string (JS string semantics), half-open [start, end). */
export interface Finding {
  category: PiiCategory | string;
  start: number;
  end: number;
  source: FindingSource;
  /** Detector confidence, 0..1. Higher wins when two findings overlap. */
  confidence: number;
}

/**
 * What a guardrail does when it detects something.
 *  - `audit`  — record findings + telemetry, never modify the payload (default).
 *  - `block`  — reject the request (input) or replace the response (output).
 *  - `mask`   — reversibly tokenize before forwarding; restore on the way back.
 *  - `redact` — irreversibly replace with a category placeholder.
 */
export type GuardrailAction = 'audit' | 'block' | 'mask' | 'redact';

export type GuardrailDirection = 'input' | 'output';

export interface GuardrailPolicy {
  action: GuardrailAction;
  /** Restrict enforcement to these categories; omit to act on every category. */
  categories?: string[];
  /** Findings below this confidence are recorded but never enforced on. */
  minConfidence?: number;
  /** Output direction only: buffer the whole response before scanning (max
   *  fidelity) rather than the default windowed streaming scan. Masking/redacting
   *  a streamed response requires this. */
  buffered?: boolean;
}

export interface GuardrailPolicies {
  input: GuardrailPolicy;
  output: GuardrailPolicy;
}

/** Audit-only in both directions — the safe default (never mutates payloads). */
export function auditOnlyPolicies(): GuardrailPolicies {
  return { input: { action: 'audit' }, output: { action: 'audit' } };
}

/** A synchronous, in-process detector (regex / secret-scan / entropy). */
export interface Detector {
  readonly name: string;
  detect(text: string): Finding[];
}

export interface GuardrailPluginResult {
  /** `none` — nothing found; `blocked` — the plugin says reject; `masked` —
   *  the plugin returned a rewritten `maskedText`. */
  action: 'none' | 'blocked' | 'masked';
  findings: Finding[];
  maskedText?: string;
}

/** An async, out-of-process guardrail (e.g. Bedrock Guardrails, Azure Content
 *  Safety). Runs alongside the native detectors when configured on a route. */
export interface GuardrailPlugin {
  readonly name: string;
  inspect(text: string, direction: GuardrailDirection): Promise<GuardrailPluginResult>;
}
