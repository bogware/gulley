import { describe, expect, it } from 'vitest';
import { WebhookGuardrailPlugin } from './webhook';

const okFetch = (verdict: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(verdict), { status })) as unknown as typeof fetch;

describe('WebhookGuardrailPlugin', () => {
  it('maps allow / block / mask verdicts onto the plugin seam', async () => {
    const allow = new WebhookGuardrailPlugin({
      url: 'https://dlp.example.com/scan',
      fetchImpl: okFetch({ action: 'allow' }),
    });
    expect((await allow.inspect('hi', 'input')).action).toBe('none');

    const block = new WebhookGuardrailPlugin({
      url: 'https://dlp.example.com/scan',
      fetchImpl: okFetch({ action: 'block', categories: ['pii'] }),
    });
    const b = await block.inspect('secret', 'input');
    expect(b.action).toBe('blocked');
    expect(b.findings[0]?.category).toBe('pii');

    const mask = new WebhookGuardrailPlugin({
      url: 'https://dlp.example.com/scan',
      fetchImpl: okFetch({ action: 'mask', maskedText: 'REDACTED' }),
    });
    const m = await mask.inspect('secret', 'input');
    expect(m.action).toBe('masked');
    expect(m.maskedText).toBe('REDACTED');
  });

  it('fails open by default and closed when configured', async () => {
    const boom = (async () => {
      throw new Error('unreachable');
    }) as unknown as typeof fetch;

    const open = new WebhookGuardrailPlugin({
      url: 'https://dlp.example.com/scan',
      fetchImpl: boom,
    });
    expect((await open.inspect('x', 'input')).action).toBe('none');

    const closed = new WebhookGuardrailPlugin({
      url: 'https://dlp.example.com/scan',
      failMode: 'closed',
      fetchImpl: boom,
    });
    expect((await closed.inspect('x', 'input')).action).toBe('blocked');
  });

  it('rejects an SSRF-unsafe webhook URL unless allowInternal is set', () => {
    expect(() => new WebhookGuardrailPlugin({ url: 'http://169.254.169.254/scan' })).toThrow();
    // An internal DLP is allowed when the operator opts in.
    expect(
      () =>
        new WebhookGuardrailPlugin({ url: 'http://dlp.internal:8080/scan', allowInternal: true }),
    ).not.toThrow();
    expect(() => new WebhookGuardrailPlugin({ url: 'https://u:p@dlp.example.com/scan' })).toThrow(
      /credentials/,
    );
  });
});
