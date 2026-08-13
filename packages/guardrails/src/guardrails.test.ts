import { describe, expect, it } from 'vitest';
import { NativeDetector, resolveOverlaps } from './detector';
import { GuardrailEngine } from './engine';
import { shannonEntropy } from './entropy';
import { StreamingReplacer, StreamingScanner } from './streaming';
import { auditOnlyPolicies, type GuardrailPlugin } from './types';
import { redactText, TokenVault } from './vault';

const det = new NativeDetector();
const cats = (text: string): string[] => det.detect(text).map((f) => f.category);

describe('NativeDetector', () => {
  it('detects common PII categories', () => {
    expect(cats('reach me at jane.doe@example.com')).toContain('email');
    expect(cats('SSN 123-45-6789 on file')).toContain('ssn');
    expect(cats('server 192.168.1.20 responded')).toContain('ip_address');
  });

  it('validates credit cards with Luhn', () => {
    expect(cats('card 4242 4242 4242 4242 expires soon')).toContain('credit_card');
    // Same shape, fails the checksum -> not a card.
    expect(cats('ref 4242 4242 4242 4241 here')).not.toContain('credit_card');
  });

  it('detects secret material by prefix', () => {
    expect(cats('AWS AKIAIOSFODNN7EXAMPLE key')).toContain('aws_access_key_id');
    expect(cats('token ghp_' + 'a'.repeat(36))).toContain('github_token');
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----';
    expect(cats(pem)).toContain('private_key');
  });

  it('attributes sk-ant keys to Anthropic, not OpenAI', () => {
    const key = 'sk-ant-api03-' + 'Ab3xZ9qLmN'.repeat(3);
    const found = det.detect(`key ${key} used`);
    const keyFindings = found.filter((f) => f.start > 0);
    expect(keyFindings.map((f) => f.category)).toContain('anthropic_key');
    expect(keyFindings.map((f) => f.category)).not.toContain('openai_key');
  });

  it('resolves overlaps in favor of the higher-confidence finding', () => {
    const resolved = resolveOverlaps([
      { category: 'high_entropy', start: 0, end: 20, source: 'entropy', confidence: 0.4 },
      { category: 'anthropic_key', start: 0, end: 20, source: 'secret', confidence: 0.97 },
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.category).toBe('anthropic_key');
  });
});

describe('shannonEntropy', () => {
  it('is zero for a constant string and high for random', () => {
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
    expect(shannonEntropy('Ab3xZ9qLmN7Qw2Ke8Rt')).toBeGreaterThan(3.5);
  });
});

describe('TokenVault', () => {
  it('round-trips reversibly and keeps JSON valid', () => {
    const vault = new TokenVault();
    const body = JSON.stringify({ msg: 'email jane@example.com and 4242 4242 4242 4242' });
    const findings = det.detect(body);
    const masked = vault.tokenize(body, findings);
    expect(masked).not.toContain('jane@example.com');
    expect(() => JSON.parse(masked)).not.toThrow(); // still valid JSON
    expect(vault.detokenize(masked)).toBe(body); // fully reversible
  });

  it('gives identical originals the same token', () => {
    const vault = new TokenVault();
    const text = 'a@b.com then a@b.com again';
    const masked = vault.tokenize(text, det.detect(text));
    const tokens = [...masked.matchAll(/<<GULLEY_[A-Z0-9_]+>>/g)].map((m) => m[0]);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBe(tokens[1]);
    expect(vault.size).toBe(1);
  });

  it('redactText is irreversible and category-labelled', () => {
    const text = 'ping jane@example.com';
    const out = redactText(text, det.detect(text));
    expect(out).toBe('ping <<REDACTED_EMAIL>>');
  });
});

describe('StreamingReplacer', () => {
  it('detokenizes tokens split across chunk boundaries', () => {
    const vault = new TokenVault();
    const text = 'value jane@example.com end';
    const masked = vault.tokenize(text, det.detect(text)); // 'value <<GULLEY_EMAIL_1>> end'
    const replacer = new StreamingReplacer(vault.entries());
    let out = '';
    // Feed one character at a time — worst case for boundary handling.
    for (const ch of masked) out += replacer.push(ch);
    out += replacer.flush();
    expect(out).toBe(text);
  });
});

describe('StreamingScanner', () => {
  it('detects a match spanning two chunks', () => {
    const scanner = new StreamingScanner(det, 64);
    scanner.push('the address is jane.d');
    scanner.push('oe@example.com today');
    expect(scanner.findings().map((f) => f.category)).toContain('email');
  });
});

describe('GuardrailEngine', () => {
  const text = 'contact jane@example.com now';

  it('audit-only records findings but never transforms', async () => {
    const engine = new GuardrailEngine([det], auditOnlyPolicies());
    const r = await engine.inspectInput(text);
    expect(r.blocked).toBe(false);
    expect(r.transformedText).toBeUndefined();
    expect(r.summary.categories['email']).toBe(1);
  });

  it('block rejects when anything is found', async () => {
    const engine = new GuardrailEngine([det], {
      input: { action: 'block' },
      output: { action: 'audit' },
    });
    expect((await engine.inspectInput(text)).blocked).toBe(true);
    expect((await engine.inspectInput('nothing here')).blocked).toBe(false);
  });

  it('mask forwards tokens and the vault restores them', async () => {
    const engine = new GuardrailEngine([det], {
      input: { action: 'mask' },
      output: { action: 'audit' },
    });
    const r = await engine.inspectInput(text);
    expect(r.transformedText).not.toContain('jane@example.com');
    expect(r.vault?.detokenize(r.transformedText ?? '')).toBe(text);
  });

  it('minConfidence suppresses weak findings', async () => {
    const engine = new GuardrailEngine([det], {
      input: { action: 'block', minConfidence: 0.9 },
      output: { action: 'audit' },
    });
    // phone confidence is 0.5 — below the threshold, so not enforced.
    expect((await engine.inspectInput('call 415-555-2671')).blocked).toBe(false);
  });
});

describe('GuardrailEngine with a provider plugin', () => {
  const blockPlugin: GuardrailPlugin = {
    name: 'test-plugin',
    async inspect() {
      return {
        action: 'blocked',
        findings: [{ category: 'test', start: 0, end: 1, source: 'plugin', confidence: 0.9 }],
      };
    },
  };

  it('blocks when the plugin intervenes, even under an audit policy', async () => {
    const engine = new GuardrailEngine([det], auditOnlyPolicies(), blockPlugin);
    const r = await engine.inspectInput('nothing native here');
    expect(r.blocked).toBe(true);
    expect(r.plugin?.name).toBe('test-plugin');
  });

  it('forwards the plugin masked text when it rewrites', async () => {
    const maskPlugin: GuardrailPlugin = {
      name: 'masker',
      async inspect() {
        return { action: 'masked', findings: [], maskedText: 'REDACTED BY PROVIDER' };
      },
    };
    const engine = new GuardrailEngine([det], auditOnlyPolicies(), maskPlugin);
    const r = await engine.inspectInput('please mask me');
    expect(r.blocked).toBe(false);
    expect(r.transformedText).toBe('REDACTED BY PROVIDER');
  });
});
