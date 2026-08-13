import { looksLikeSecretMaterial, redactValue } from '@gulley/pipeline';

/** Global no-content mode, gated at every sink (log / OTel / cache). Credential
 *  scrubbing is ALWAYS on and independent of this flag. */
export interface SinkPolicy {
  noContent: boolean;
}

/** Span attributes we ALLOW to be exported — everything else is dropped (never
 *  auto-capture headers/content). Structured, credential-free, GenAI-convention. */
export const SPAN_ATTR_ALLOWLIST: ReadonlySet<string> = new Set([
  'gen_ai.operation.name',
  'gen_ai.provider.name',
  'gen_ai.system',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.response.finish_reasons',
  'gulley.cost.micro_usd',
  'gulley.route',
  'gulley.streamed',
  'gulley.cache.status',
  'gulley.guardrail.input.findings',
  'gulley.guardrail.output.findings',
  'gulley.guardrail.action',
  'http.response.status_code',
]);

/** Headers that must never reach a log/span/sink (always-on denylist). */
export const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'set-cookie',
  'x-amz-security-token',
  'x-amz-content-sha256',
  'x-goog-api-key',
]);

/** Keep only allowlisted span attributes. */
export function filterSpanAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (SPAN_ATTR_ALLOWLIST.has(k)) out[k] = v;
  }
  return out;
}

/** Drop sensitive headers (case-insensitive). Always applied, independent of
 *  no-content mode. */
export function scrubHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined && !SENSITIVE_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** Recursively replace secret-format string values with [REDACTED]. Reuses the
 *  audit sanitizer's detector so the denylist stays single-sourced. */
export function scrub(value: unknown): unknown {
  return redactValue(value);
}

export { looksLikeSecretMaterial };
