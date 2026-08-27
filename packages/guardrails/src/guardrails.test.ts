import { describe, expect, it } from 'vitest';
import { NativeDetector, resolveOverlaps } from './detector';
import { filterByPolicy, GuardrailEngine } from './engine';
import { shannonEntropy } from './entropy';
import { StreamingRedactor, StreamingReplacer, StreamingScanner } from './streaming';
import { auditOnlyPolicies, type Detector, type GuardrailPlugin } from './types';
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

  it('validates phone numbers for NANP/E.164 plausibility', () => {
    expect(cats('call 415-555-2671')).toContain('phone'); // valid NANP
    expect(cats('ref 111-555-2671 here')).not.toContain('phone'); // area code starts with 1
  });

  it('detects a Luhn-valid Canadian SIN and http(s) URLs', () => {
    expect(cats('SIN 046 454 286 on file')).toContain('ca_sin'); // Luhn-valid example SIN
    expect(cats('random 123 456 789 here')).not.toContain('ca_sin'); // fails Luhn
    expect(cats('visit https://acme.example.com/path?token=abc')).toContain('url');
  });

  it('boosts confidence when a category context word sits nearby', () => {
    const find = (text: string, category: string) =>
      det.detect(text).find((f) => f.category === category);
    // SSN base confidence 0.8 → 0.98 with the "SSN" context word.
    expect(find('SSN 123-45-6789 on file', 'ssn')?.confidence).toBeGreaterThan(0.9);
    // Same digits, no context word → base confidence only.
    expect(find('value 123-45-6789 logged', 'ssn')?.confidence).toBeCloseTo(0.8, 5);

    const boosted = new NativeDetector();
    const plain = new NativeDetector({ contextBoost: false });
    const sinCtx = 'social insurance 046 454 286';
    expect(boosted.detect(sinCtx).find((f) => f.category === 'ca_sin')?.confidence).toBeGreaterThan(
      plain.detect(sinCtx).find((f) => f.category === 'ca_sin')?.confidence ?? 0,
    );
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

describe('StreamingRedactor', () => {
  const redact = { action: 'redact' as const };

  it('redacts equivalently to redactText across arbitrary chunk boundaries', () => {
    const text = 'contact jane@example.com or bob@work.io before noon';
    const expected = redactText(text, filterByPolicy(det.detect(text), redact));
    const r = new StreamingRedactor(det, redact, 32);
    let out = '';
    for (const ch of text) out += r.push(ch); // char-by-char: worst case for boundaries
    out += r.flush();
    expect(out).toBe(expected);
    expect(out).not.toContain('jane@example.com');
  });

  it('holds a match spanning two chunks, then redacts it (never emits a partial secret)', () => {
    const r = new StreamingRedactor(det, redact, 64);
    let out = r.push('the address is jane.d'); // partial email must be held back
    expect(out).not.toContain('jane.d');
    out += r.push('oe@example.com today');
    out += r.flush();
    expect(out).toContain('<<REDACTED_EMAIL>>');
    expect(out).not.toContain('jane.doe@example.com');
    expect(out).toContain('today');
  });

  it('records de-duplicated findings for the audit trail', () => {
    const r = new StreamingRedactor(det, redact, 16);
    for (const ch of 'x jane@example.com y') r.push(ch);
    r.flush();
    expect(r.findings().filter((f) => f.category === 'email')).toHaveLength(1);
  });

  it('block: emits clean content up to the first finding, then blocks (no partial leak)', () => {
    const r = new StreamingRedactor(det, { action: 'block' }, 8);
    let out = r.push('all clear ');
    out += r.push('leak jane@example.com ' + 'z'.repeat(40));
    expect(r.blocked).toBe(true);
    expect(out).toContain('all clear');
    expect(out).not.toContain('jane@example.com');
    expect(r.push('more')).toBe(''); // terminal: nothing more is emitted
  });

  it('fails closed when an open-ended match overflows the hold buffer', () => {
    // A pathological detector whose match always spans the whole buffer keeps
    // pulling the safe boundary back, so the hold buffer grows past the cap.
    const growing: Detector = {
      name: 'growing',
      detect: (t) =>
        t.length
          ? [
              {
                category: 'high_entropy',
                start: 0,
                end: t.length,
                source: 'entropy',
                confidence: 1,
              },
            ]
          : [],
    };
    const r = new StreamingRedactor(growing, redact, 8); // maxBuffer floors at 8192
    for (let i = 0; i < 2000; i++) r.push('xxxxx'); // 10000 chars, never emittable
    expect(r.failClosed).toBe(true);
  });

  it('never leaks the prefix of a long unkeyed high-entropy secret (self-straddling)', () => {
    // The entropy candidate regex is open-ended (matches a run to the buffer end),
    // so a long secret with no known prefix is detected on its partial run and its
    // finding straddles the window boundary — held without needing an anchor.
    const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const secret = alpha.repeat(14); // 868 chars, high entropy, > window, no prefix
    const text = 'here is a token ' + secret + ' end';
    const r = new StreamingRedactor(det, { action: 'redact', minConfidence: 0.3 }, 64);
    let out = '';
    for (let i = 0; i < text.length; i += 19) out += r.push(text.slice(i, i + 19));
    out += r.flush();
    expect(out).not.toContain(alpha.repeat(2)); // no run of the secret ever emitted
    expect(out).toContain('<<REDACTED_HIGH_ENTROPY>>');
    expect(out).toContain('end');
  });

  it('never leaks the leading bytes of a PEM private key longer than the window', () => {
    const bodyLine = 'MIIBOwIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Q';
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\n' +
      Array(15).fill(bodyLine).join('\n') +
      '\n-----END RSA PRIVATE KEY-----';
    const r = new StreamingRedactor(det, { action: 'redact', minConfidence: 0.5 }, 64); // window << pem
    let out = '';
    for (let i = 0; i < pem.length; i += 17) out += r.push(pem.slice(i, i + 17));
    out += r.flush();
    expect(out).not.toContain(bodyLine); // no key material ever emitted
    expect(out).toContain('<<REDACTED_PRIVATE_KEY>>');
  });

  it('never leaks a JWT longer than the window', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + 'a'.repeat(300) + '.' + 'b'.repeat(300);
    const text = 'token ' + jwt + ' end';
    const r = new StreamingRedactor(det, { action: 'redact', minConfidence: 0.5 }, 64);
    let out = '';
    for (let i = 0; i < text.length; i += 13) out += r.push(text.slice(i, i + 13));
    out += r.flush();
    expect(out).not.toContain('a'.repeat(64)); // JWT payload never emitted
    expect(out).toContain('<<REDACTED_JWT>>');
    expect(out).toContain('token');
    expect(out).toContain('end');
  });

  it('does not fail closed on a long base64 blob that merely begins with eyJ', () => {
    // No dot after the header run → not a forming JWT → must not be held/withheld.
    const blob = 'eyJ' + 'A'.repeat(4000); // > maxBuffer, but not a JWT
    const text = 'data: ' + blob + ' done';
    const r = new StreamingRedactor(det, { action: 'redact', minConfidence: 0.5 }, 64);
    let out = '';
    for (let i = 0; i < text.length; i += 29) out += r.push(text.slice(i, i + 29));
    out += r.flush();
    expect(r.failClosed).toBe(false);
    expect(out).toContain(blob); // emitted intact, not withheld
  });

  it('fails closed when a PEM begin marker never closes (over cap, no leak)', () => {
    const r = new StreamingRedactor(det, { action: 'redact' }, 64); // maxBuffer 8192
    let out = r.push('-----BEGIN RSA PRIVATE KEY-----\n');
    for (let i = 0; i < 500; i++) out += r.push('MIIBOwIBAAJBAKj34GkxFhD9\n'); // 12500 chars, no END
    expect(r.failClosed).toBe(true);
    expect(out).not.toContain('MIIBOwIBAAJBAKj34GkxFhD9'); // body withheld, never emitted
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

  it('consults the plugin on the OUTPUT path (block + mask), even under audit', async () => {
    const seen: string[] = [];
    const directionPlugin = (result: {
      action: 'blocked' | 'masked' | 'none';
      maskedText?: string;
    }): GuardrailPlugin => ({
      name: 'out',
      async inspect(_t, direction) {
        seen.push(direction);
        return { findings: [], ...result };
      },
    });

    const blocked = await new GuardrailEngine(
      [det],
      auditOnlyPolicies(),
      directionPlugin({ action: 'blocked' }),
    ).inspectOutput('a leaked response');
    expect(blocked.blocked).toBe(true);
    expect(seen).toContain('output'); // the plugin ran on the output direction

    const masked = await new GuardrailEngine(
      [det],
      auditOnlyPolicies(),
      directionPlugin({ action: 'masked', maskedText: 'SANITIZED' }),
    ).inspectOutput('a leaked response');
    expect(masked).toMatchObject({ blocked: false, transformedText: 'SANITIZED' });
  });
});
