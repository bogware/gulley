import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENV_KEYS, loadConfig, normalizeEnv } from './config';

/** Parse `.env.example` the way compose `env_file` does: every `KEY=value` line, empty
 *  values included (that is exactly the shape that used to crash boot). */
function envExample(): Record<string, string> {
  const path = fileURLToPath(new URL('../../../.env.example', import.meta.url));
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(raw);
    if (!m) continue;
    let v = (m[2] ?? '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    out[m[1] as string] = v;
  }
  return out;
}

describe('loadConfig — empty env values fall back to defaults', () => {
  it('drops empty and whitespace-only entries before validation', () => {
    expect(normalizeEnv({ A: '', B: '  ', C: 'x', D: undefined })).toEqual({ C: 'x' });
  });

  it('an empty boolean/number/constrained-string knob behaves exactly like an unset one', () => {
    const cfg = loadConfig({
      BUDGET_FAIL_OPEN: '',
      GUARDRAILS_ENABLED: '',
      CONFIG_POLL_INTERVAL_SECONDS: '',
      CACHE_SWEEP_INTERVAL_SECONDS: '',
      TRACE_SAMPLE_RATIO: '',
      CACHE_SIMILARITY_THRESHOLD: '',
      ANTHROPIC_UPSTREAM_API_KEY: '',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
      REDIS_COUNTERS_URL: '   ',
    });
    const defaults = loadConfig({});
    expect(cfg.BUDGET_FAIL_OPEN).toBe(defaults.BUDGET_FAIL_OPEN);
    expect(cfg.GUARDRAILS_ENABLED).toBe(defaults.GUARDRAILS_ENABLED);
    expect(cfg.CONFIG_POLL_INTERVAL_SECONDS).toBe(defaults.CONFIG_POLL_INTERVAL_SECONDS);
    expect(cfg.CACHE_SWEEP_INTERVAL_SECONDS).toBe(defaults.CACHE_SWEEP_INTERVAL_SECONDS);
    expect(cfg.TRACE_SAMPLE_RATIO).toBe(defaults.TRACE_SAMPLE_RATIO);
    expect(cfg.CACHE_SIMILARITY_THRESHOLD).toBe(defaults.CACHE_SIMILARITY_THRESHOLD);
    expect(cfg.ANTHROPIC_UPSTREAM_API_KEY).toBeUndefined();
    expect(cfg.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(cfg.REDIS_COUNTERS_URL).toBeUndefined();
  });

  it('still rejects an explicitly wrong value', () => {
    expect(() => loadConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'not a url' })).toThrow();
    expect(() => loadConfig({ GATEWAY_PORT: 'eighty' })).toThrow();
  });

  it('parses the shipped .env.example verbatim (compose env_file semantics)', () => {
    expect(() => loadConfig(envExample())).not.toThrow();
  });
});

describe('loadConfig — inter-dependent knobs', () => {
  it('rejects a classification budget that cannot outlive the embed timeout', () => {
    expect(() =>
      loadConfig({
        SMART_ROUTING_EMBED_TIMEOUT_MS: '2000',
        SMART_ROUTING_CLASSIFY_TIMEOUT_MS: '2000',
      }),
    ).toThrow(/SMART_ROUTING_EMBED_TIMEOUT_MS/);
  });

  it('pins the embedding width to the pgvector column when the semantic tier is on', () => {
    expect(() =>
      loadConfig({ CACHE_SEMANTIC_ENABLED: 'true', EMBEDDINGS_DIMENSIONS: '1024' }),
    ).toThrow(/vector\(256\)/);
    expect(() =>
      loadConfig({
        CACHE_SEMANTIC_ENABLED: 'true',
        CACHE_VECTOR_BACKEND: 'memory',
        EMBEDDINGS_DIMENSIONS: '1024',
      }),
    ).not.toThrow();
  });

  it('requires the KMS key for a persisted mask vault in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', MASK_VAULT_PERSIST: 'true' })).toThrow(
      /GULLEY_KMS_KEY_ARN/,
    );
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        MASK_VAULT_PERSIST: 'true',
        GULLEY_KMS_KEY_ARN: 'arn:aws:kms:us-east-1:123456789012:key/abc',
      }),
    ).not.toThrow();
  });

  it('defaults the KMS region to the Bedrock region only at the wiring site (knob stays optional)', () => {
    expect(loadConfig({}).GULLEY_KMS_REGION).toBeUndefined();
    expect(loadConfig({ GULLEY_KMS_REGION: 'eu-west-1' }).GULLEY_KMS_REGION).toBe('eu-west-1');
  });
});

describe('.env.example documents every gateway knob', () => {
  it('every schema key appears as a KEY= or # KEY= line', () => {
    const text = readFileSync(
      fileURLToPath(new URL('../../../.env.example', import.meta.url)),
      'utf8',
    );
    const missing = ENV_KEYS.filter((k) => !new RegExp(`^#? ?${k}=`, 'm').test(text));
    expect(missing, `add these to .env.example: ${missing.join(', ')}`).toEqual([]);
  });
});
