import { describe, expect, it } from 'vitest';
import { type RequestSpanData, spanAttributes } from './otel';

/**
 * Guards the always-on no-credential-logging invariant (ARCHITECTURE §12) on the OTel
 * span path: the exported span attributes must stay confined to a structured
 * gen_ai.* / gulley.* / http.* allowlist, so a later change that added a header-bearing
 * or content attribute (e.g. an Authorization header) would fail here — independent of
 * the no-content toggle. RequestSpanData carries no header/content field by construction;
 * these tests make that a contract instead of an accident.
 */

// Every span-attribute field populated, including a credential-like token smuggled into
// each free-text field — none of which is a header, but the fuzz proves the attribute
// SURFACE never grows a header/credential-named key regardless of input.
const CREDENTIAL = 'sk-ant-SUPERSECRET-abc123';
const fullData: RequestSpanData = {
  provider: 'anthropic',
  requestModel: 'claude-sonnet-4-6',
  responseModel: 'claude-sonnet-4-6',
  route: '/v1/messages',
  servedRegion: 'eu-central-1',
  statusCode: 200,
  status: 'ok',
  inputTokens: 100,
  outputTokens: 42,
  costMicroUsd: 1234,
  streamed: true,
  stopReason: 'end_turn',
  startedAtMs: 0,
  cacheStatus: 'miss',
  guardrailInputFindings: 0,
  guardrailOutputFindings: 1,
  guardrailAction: 'redact',
  cacheReadTokens: 20,
  cacheWriteTokens: 10,
  traceId: 'abcdef01234567890abcdef012345678',
  abortReason: 'watchdog',
  budgetEnforced: false,
  rateLimitEnforced: false,
};

const ALLOWED_PREFIX = /^(gen_ai|gulley|http)\./;
// Credential/header-named keys that must NEVER appear (excludes the *_tokens usage keys,
// which legitimately contain the substring "token").
const FORBIDDEN_KEY = /authorization|cookie|api.?key|x-api|secret|credential|bearer|\.headers?\b/i;

describe('spanAttributes — no-credential-logging invariant', () => {
  it('confines every attribute KEY to the gen_ai.* / gulley.* / http.* allowlist', () => {
    const attrs = spanAttributes(fullData);
    for (const key of Object.keys(attrs)) {
      expect(key, `attribute key "${key}" is outside the allowlist`).toMatch(ALLOWED_PREFIX);
      expect(key, `attribute key "${key}" looks header/credential-bearing`).not.toMatch(
        FORBIDDEN_KEY,
      );
    }
  });

  it('emits ONLY the known structured attribute set (a new attribute must be reviewed here)', () => {
    const keys = Object.keys(spanAttributes(fullData)).sort();
    expect(keys).toEqual(
      [
        'gen_ai.operation.name',
        'gen_ai.provider.name',
        'gen_ai.request.model',
        'gen_ai.response.finish_reasons',
        'gen_ai.response.model',
        'gen_ai.system',
        'gen_ai.usage.cache_creation.input_tokens',
        'gen_ai.usage.cache_read.input_tokens',
        'gen_ai.usage.input_tokens',
        'gen_ai.usage.output_tokens',
        'gulley.abort.reason',
        'gulley.budget.enforced',
        'gulley.cache.status',
        'gulley.cost.micro_usd',
        'gulley.guardrail.action',
        'gulley.guardrail.input.findings',
        'gulley.guardrail.output.findings',
        'gulley.ratelimit.enforced',
        'gulley.route',
        'gulley.served.region',
        'gulley.streamed',
        'gulley.trace_id',
        'http.response.status_code',
      ].sort(),
    );
  });

  it('every attribute VALUE is a structured primitive (or array of them) — never a nested object that could smuggle a headers map', () => {
    const attrs = spanAttributes(fullData);
    for (const [key, value] of Object.entries(attrs)) {
      const ok =
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        (Array.isArray(value) && value.every((v) => typeof v === 'string'));
      expect(ok, `attribute "${key}" has a non-primitive value`).toBe(true);
    }
  });

  it('a credential fed into a request field appears ONLY in that field, never duplicated into a header-shaped attribute', () => {
    // Even if a caller (or a regression) put a secret into a free-text field, it must not
    // fan out into a new credential-named attribute — the surface stays fixed.
    const tainted = spanAttributes({ ...fullData, route: `/v1/messages?leak=${CREDENTIAL}` });
    const carriers = Object.entries(tainted).filter(([, v]) => String(v).includes(CREDENTIAL));
    expect(carriers.map(([k]) => k)).toEqual(['gulley.route']); // exactly the field it was put in
  });
});
