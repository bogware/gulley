import { describe, expect, it } from 'vitest';
import { CompositeGuardrailPlugin } from './composite';
import { capFindings, MAX_RAW_FINDINGS, NativeDetector, resolveOverlaps } from './detector';
import { GuardrailEngine } from './engine';
import { InjectionDetector } from './injection';
import { StreamingRedactor } from './streaming';
import type { Finding, GuardrailPlugin } from './types';
import { TokenVault } from './vault';

const det = new NativeDetector({});

describe('resolveOverlaps — linear-time and bounded', () => {
  it('keeps the same greedy result as the quadratic version on overlapping spans', () => {
    const f = (start: number, end: number, confidence: number, category = 'x'): Finding => ({
      category,
      start,
      end,
      source: 'pattern',
      confidence,
    });
    const out = resolveOverlaps([f(0, 10, 0.5), f(5, 15, 0.9), f(20, 30, 0.7), f(25, 28, 0.99)]);
    expect(out.map((x) => [x.start, x.end])).toEqual([
      [5, 15],
      [25, 28],
    ]);
  });

  it('resolves 100k disjoint findings well under a second (was minutes)', () => {
    const many: Finding[] = [];
    for (let i = 0; i < 100_000; i++)
      many.push({
        category: 'email',
        start: i * 8,
        end: i * 8 + 6,
        source: 'pattern',
        confidence: 0.8,
      });
    const t = Date.now();
    expect(resolveOverlaps(many)).toHaveLength(100_000);
    expect(Date.now() - t).toBeLessThan(1_000);
  });

  it('a flood of matches is capped and marked with a fail-closed overflow finding', () => {
    const body = 'a@b.co '.repeat(60_000); // ~60k email matches
    const t = Date.now();
    const out = det.detect(body);
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(out.length).toBeLessThanOrEqual(MAX_RAW_FINDINGS + 1);
    expect(out.some((f) => f.category === 'detector_overflow' && f.confidence >= 0.99)).toBe(true);
    expect(capFindings([], 10)).toEqual([]);
  });

  it('injection: a run of zero-width characters is ONE finding and the scan is bounded', () => {
    const inj = new InjectionDetector();
    const out = inj.detect('​'.repeat(200_000));
    expect(out).toHaveLength(1);
    expect(out[0]!.end).toBe(200_000);
  });
});

describe('TokenVault — per-vault token namespace', () => {
  it('two vaults never share a token; a foreign token is left untouched', () => {
    const a = new TokenVault();
    const b = new TokenVault();
    const text = 'mail bob@work.io now';
    const ma = a.tokenize(text, det.detect(text));
    const mb = b.tokenize(text, det.detect(text));
    expect(ma).not.toBe(mb);
    expect(ma).toMatch(/<<GULLEY_EMAIL_[0-9A-F]{8}_1>>/);
    expect(b.detokenize(ma)).toBe(ma); // a's token is not b's
    expect(a.detokenize(ma)).toBe(text);
  });
});

describe('StreamingRedactor — terminal()', () => {
  it('is terminal once a block policy fires, and emits nothing afterwards', () => {
    const r = new StreamingRedactor(det, { action: 'block' }, 16);
    r.push('hello AKIAIOSFODNN7EXAMPLE tail');
    r.flush();
    expect(r.blocked).toBe(true);
    expect(r.terminal()).toBe(true);
    expect(r.push('more')).toBe('');
  });
});

const whole = (text: string, category: string): Finding => ({
  category,
  start: 0,
  end: text.length,
  source: 'plugin',
  confidence: 1,
});

describe('GuardrailEngine — plugin verdicts compose with the native transform', () => {
  it('input: a plugin mask no longer tokenizes the whole body; the native mask still applies to what remains', async () => {
    const plugin: GuardrailPlugin = {
      name: 'dlp',
      inspect: async (text) => ({
        action: 'masked',
        findings: [whole(text, 'dlp_pii')],
        maskedText: text.replace('4242 4242 4242 4242', '[CARD]'),
      }),
    };
    const engine = new GuardrailEngine(
      [det],
      { input: { action: 'mask' }, output: { action: 'audit' } },
      plugin,
    );
    const r = await engine.inspectInput('{"m":"card 4242 4242 4242 4242 mail jane@example.com"}');
    expect(r.blocked).toBe(false);
    expect(r.transformedText).toContain('[CARD]');
    expect(r.transformedText).toMatch(/<<GULLEY_EMAIL_[0-9A-F]{8}_1>>/);
    expect(r.transformedText).not.toContain('jane@example.com');
    expect(JSON.parse(r.transformedText!)).toBeTypeOf('object'); // still a JSON object
  });

  it('output: natives re-run over the plugin-masked text (a token the plugin missed is still masked)', async () => {
    const plugin: GuardrailPlugin = {
      name: 'dlp',
      inspect: async (text) => ({
        action: 'masked',
        findings: [whole(text, 'dlp_pii')],
        maskedText: text.replace('jane@example.com', '[EMAIL]'),
      }),
    };
    const engine = new GuardrailEngine(
      [det],
      { input: { action: 'audit' }, output: { action: 'mask' } },
      plugin,
    );
    const r = await engine.inspectOutput(
      'reply: jane@example.com and ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD',
    );
    expect(r.transformedText).toContain('[EMAIL]');
    expect(r.transformedText).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(r.vault?.size).toBe(1);
  });

  it('a degraded plugin verdict fires the hook (fail-open outage is no longer silent) and composites propagate it', async () => {
    const down: GuardrailPlugin = {
      name: 'moderation',
      inspect: async () => ({ action: 'none', findings: [], degraded: true }),
    };
    const seen: string[] = [];
    const engine = new GuardrailEngine(
      [det],
      { input: { action: 'audit' }, output: { action: 'audit' } },
      new CompositeGuardrailPlugin([down]),
      { onPluginDegraded: (p, d) => seen.push(`${p}:${d}`) },
    );
    await engine.inspectInput('hello');
    await engine.inspectOutput('world');
    expect(seen).toEqual(['composite:input', 'composite:output']);
  });
});
