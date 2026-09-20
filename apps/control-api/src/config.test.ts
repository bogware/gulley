import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENV_KEYS, loadConfig, normalizeEnv } from './config';

/** Parse `.env.example` like compose `env_file`: every `KEY=value` line, empties included. */
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
    expect(normalizeEnv({ A: '', B: ' ', C: 'x' })).toEqual({ C: 'x' });
  });

  it('an empty knob behaves exactly like an unset one', () => {
    const cfg = loadConfig({
      ADMIN_CSRF_ENABLED: '',
      CONTROL_API_TRUST_PROXY_HOPS: '',
      CONTROL_API_AUTH_RATE_LIMIT_PER_MIN: '',
      GULLEY_ADMIN_SESSION_SECRET: '',
      DATABASE_URL: '',
    });
    const defaults = loadConfig({});
    expect(cfg.ADMIN_CSRF_ENABLED).toBe(defaults.ADMIN_CSRF_ENABLED);
    expect(cfg.CONTROL_API_TRUST_PROXY_HOPS).toBe(defaults.CONTROL_API_TRUST_PROXY_HOPS);
    expect(cfg.CONTROL_API_AUTH_RATE_LIMIT_PER_MIN).toBe(
      defaults.CONTROL_API_AUTH_RATE_LIMIT_PER_MIN,
    );
    expect(cfg.GULLEY_ADMIN_SESSION_SECRET).toBeUndefined();
    expect(cfg.DATABASE_URL).toBeUndefined();
  });

  it('still rejects an explicitly wrong value', () => {
    expect(() => loadConfig({ GULLEY_ADMIN_SESSION_SECRET: 'short' })).toThrow();
    expect(() => loadConfig({ DATABASE_URL: 'nope' })).toThrow();
  });

  it('parses the shipped .env.example verbatim (compose env_file semantics)', () => {
    expect(() => loadConfig(envExample())).not.toThrow();
  });
});

describe('.env.example documents every control-api knob', () => {
  it('every schema key appears as a KEY= or # KEY= line', () => {
    const text = readFileSync(
      fileURLToPath(new URL('../../../.env.example', import.meta.url)),
      'utf8',
    );
    const missing = ENV_KEYS.filter((k) => !new RegExp(`^#? ?${k}=`, 'm').test(text));
    expect(missing, `add these to .env.example: ${missing.join(', ')}`).toEqual([]);
  });
});
