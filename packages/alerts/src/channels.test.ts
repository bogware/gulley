import { describe, expect, it } from 'vitest';
import {
  AlertDeliveryError,
  EmailChannel,
  emailMessage,
  type MailMessage,
  pagerdutyDedupKey,
  pagerdutyPayload,
  parseSmtpUrl,
  slackPayload,
  teamsPayload,
  verifyWebhookSignature,
  webhookDelivery,
} from './channels';
import { alertEntity, alertSummary, alertText } from './format';
import { type AlertEvent, defaultSeverity, makeAlert } from './types';

const AT = '2026-10-11T12:00:00.000Z';

const budget: AlertEvent = {
  kind: 'budget.exceeded',
  at: AT,
  severity: 'critical',
  scope: 'ws-1',
  scopeKind: 'workspace',
  entity: 'ws-1',
  window: 'monthly',
  usedMicroUsd: 1_250_000_000,
  capMicroUsd: 1_000_000_000,
  workspaceId: 'ws-1',
  requestId: 'req-9',
};

const breakerOpen: AlertEvent = {
  kind: 'breaker.open',
  at: AT,
  severity: 'critical',
  target: 'anthropic:primary',
  provider: 'anthropic',
};

const keyExpiring: AlertEvent = {
  kind: 'key.expiring',
  at: AT,
  severity: 'warning',
  keyId: 'k-1',
  displayName: 'ci-bot',
  workspaceId: 'ws-1',
  expiresAt: '2026-10-15T00:00:00.000Z',
  daysLeft: 4,
};

describe('makeAlert / format', () => {
  it('stamps at + the per-kind default severity; flagged runaway downgrades to warning', () => {
    const now = () => new Date(AT);
    const e = makeAlert({ kind: 'breaker.open', target: 't', provider: 'p' }, now);
    expect(e).toMatchObject({ at: AT, severity: 'critical' });
    expect(defaultSeverity('config.applied')).toBe('info');
    const flagged = makeAlert(
      {
        kind: 'session.runaway',
        session: 's',
        workspaceId: 'w',
        costMicroUsd: 1,
        baselineMicroUsd: 1,
        orgP99MicroUsd: 1,
        action: 'flagged',
      },
      now,
    );
    expect(flagged.severity).toBe('warning');
    const explicit = makeAlert(
      { kind: 'config.applied', version: 1, contentHash: 'h', actor: 'a', severity: 'critical' },
      now,
    );
    expect(explicit.severity).toBe('critical');
  });

  it('derives a stable entity per kind and a one-line summary', () => {
    expect(alertEntity(budget)).toBe('ws-1');
    expect(alertEntity(breakerOpen)).toBe('anthropic:primary');
    expect(alertEntity(keyExpiring)).toBe('k-1');
    expect(alertSummary(budget)).toContain('$1250.00 of $1000.00');
    expect(alertText(keyExpiring)).toContain('Days left: 4');
  });
});

describe('slackPayload', () => {
  it('carries a text fallback and Block Kit blocks with at most 10 fields', () => {
    const p = slackPayload(budget) as { text: string; blocks: Array<Record<string, unknown>> };
    expect(p.text).toContain('Budget exceeded');
    expect(p.blocks[0]).toMatchObject({ type: 'header' });
    const fields = (p.blocks[2] as { fields: unknown[] }).fields;
    expect(fields.length).toBeLessThanOrEqual(10);
    expect(JSON.stringify(p)).toContain('req-9');
  });
});

describe('teamsPayload', () => {
  it('wraps one Adaptive Card in a Workflows message envelope', () => {
    const p = teamsPayload(breakerOpen) as {
      type: string;
      attachments: Array<{
        contentType: string;
        content: { type: string; version: string; body: Array<{ type: string }> };
      }>;
    };
    expect(p.type).toBe('message');
    expect(p.attachments[0]?.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(p.attachments[0]?.content.type).toBe('AdaptiveCard');
    expect(p.attachments[0]?.content.body.some((b) => b.type === 'FactSet')).toBe(true);
  });
});

describe('pagerdutyPayload', () => {
  it('triggers with dedup_key kind:entity, mapped severity and custom_details', () => {
    const p = pagerdutyPayload(budget, 'rk', {
      severityMap: { critical: 'error' },
      source: 'gw',
    }) as {
      routing_key: string;
      event_action: string;
      dedup_key: string;
      payload: {
        severity: string;
        source: string;
        class: string;
        custom_details: Record<string, unknown>;
      };
    };
    expect(p.routing_key).toBe('rk');
    expect(p.event_action).toBe('trigger');
    expect(p.dedup_key).toBe('budget.exceeded:ws-1');
    expect(p.payload.severity).toBe('error');
    expect(p.payload.source).toBe('gw');
    expect(p.payload.class).toBe('budget.exceeded');
    expect(p.payload.custom_details['requestId']).toBe('req-9');
    expect(p.payload.custom_details['kind']).toBeUndefined();
  });

  it('resolves the open incident on breaker.closed', () => {
    const closed: AlertEvent = { ...breakerOpen, kind: 'breaker.closed', severity: 'info' };
    expect(pagerdutyDedupKey(closed)).toBe('breaker.open:anthropic:primary');
    expect(pagerdutyPayload(closed, 'rk')).toEqual({
      routing_key: 'rk',
      event_action: 'resolve',
      dedup_key: 'breaker.open:anthropic:primary',
    });
  });
});

describe('webhook signature', () => {
  const secret = 'a-shared-secret-of-sufficient-length';

  it('signs the verbatim body with t=<seconds>,v1=<hmac> and sets the delivery headers', () => {
    const d = webhookDelivery(keyExpiring, secret, 'deliv-1', 1_760_000_000);
    expect(d.body).toBe(JSON.stringify(keyExpiring));
    expect(d.headers['x-gulley-event']).toBe('key.expiring');
    expect(d.headers['x-gulley-delivery']).toBe('deliv-1');
    expect(d.headers['x-gulley-signature']).toMatch(/^t=1760000000,v1=[0-9a-f]{64}$/);
    const r = verifyWebhookSignature(secret, d.headers['x-gulley-signature'], d.body, {
      now: () => 1_760_000_100,
    });
    expect(r).toEqual({ ok: true, timestamp: 1_760_000_000 });
  });

  it('rejects a tampered body, a wrong secret, a stale timestamp and a malformed header', () => {
    const d = webhookDelivery(keyExpiring, secret, 'deliv-1', 1_760_000_000);
    const sig = d.headers['x-gulley-signature'];
    const now = () => 1_760_000_010;
    expect(verifyWebhookSignature(secret, sig, `${d.body} `, { now })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(verifyWebhookSignature('another-secret-entirely-xx', sig, d.body, { now })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(verifyWebhookSignature(secret, sig, d.body, { now: () => 1_760_000_000 + 301 })).toEqual(
      { ok: false, reason: 'expired' },
    );
    expect(
      verifyWebhookSignature(secret, sig, d.body, {
        now: () => 1_760_000_000 + 301,
        toleranceSeconds: 600,
      }).ok,
    ).toBe(true);
    expect(verifyWebhookSignature(secret, undefined, d.body, { now })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyWebhookSignature(secret, 'v1=abc', d.body, { now })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyWebhookSignature(secret, 't=x,v1=00', d.body, { now })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('email', () => {
  it('parses smtps:// (implicit TLS) and smtp:// (STARTTLS required unless plaintext is allowed)', () => {
    expect(parseSmtpUrl('smtps://us%40er:p%40ss@smtp.test')).toMatchObject({
      host: 'smtp.test',
      port: 465,
      secure: true,
      requireTLS: false,
      auth: { user: 'us@er', pass: 'p@ss' },
    });
    expect(parseSmtpUrl('smtp://smtp.test:2525')).toMatchObject({
      host: 'smtp.test',
      port: 2525,
      secure: false,
      requireTLS: true,
    });
    expect(parseSmtpUrl('smtp://smtp.test:2525').auth).toBeUndefined();
    expect(parseSmtpUrl('smtp://smtp.test', { allowPlaintext: true }).requireTLS).toBe(false);
    expect(() => parseSmtpUrl('https://smtp.test')).toThrow(/smtp:\/\/ or smtps:\/\//);
    expect(() => parseSmtpUrl('nope')).toThrow(/not a URL/);
  });

  it('builds a [gulley] <kind>: <entity> plain-text message', () => {
    const m = emailMessage(keyExpiring, 'gulley@acme.test', ['ops@acme.test']);
    expect(m.subject).toBe('[gulley] key.expiring: k-1');
    expect(m.text).toContain('Virtual key expiring [warning]');
    expect(m.to).toEqual(['ops@acme.test']);
  });

  it('sends through the injected mailer and classifies SMTP failures', async () => {
    const sent: MailMessage[] = [];
    let fail: unknown;
    const channel = new EmailChannel(
      'email',
      parseSmtpUrl('smtps://smtp.test'),
      'gulley@acme.test',
      ['ops@acme.test'],
      () => ({
        sendMail: async (m) => {
          if (fail) throw fail;
          sent.push(m);
        },
      }),
    );
    await channel.send(keyExpiring, { id: 'd', attempt: 1 });
    expect(sent[0]?.subject).toBe('[gulley] key.expiring: k-1');

    fail = Object.assign(new Error('auth'), { code: 'EAUTH', responseCode: 535 });
    await expect(channel.send(keyExpiring, { id: 'd', attempt: 1 })).rejects.toMatchObject({
      name: 'AlertDeliveryError',
      retryable: false,
    });
    fail = Object.assign(new Error('busy'), { responseCode: 421 });
    const err = await channel.send(keyExpiring, { id: 'd', attempt: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlertDeliveryError);
    expect((err as AlertDeliveryError).retryable).toBe(true);
    fail = Object.assign(new Error('conn'), { code: 'ECONNECTION' });
    await expect(channel.send(keyExpiring, { id: 'd', attempt: 1 })).rejects.toMatchObject({
      retryable: true,
    });
  });
});
