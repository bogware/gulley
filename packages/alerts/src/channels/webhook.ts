import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AlertEvent } from '../types';
import { type AlertChannel, type DeliveryAttempt, type HttpDeps, postJson } from './channel';

/**
 * Generic signed webhook. The body is the event JSON verbatim; the headers carry the
 * kind, a delivery id (stable across retries — dedupe on it) and an HMAC signature:
 *
 *   x-gulley-event:     <kind>
 *   x-gulley-delivery:  <uuid>
 *   x-gulley-signature: t=<unix seconds>,v1=<hex hmac-sha256(secret, "<t>.<raw body>")>
 *
 * Verify with {@link verifyWebhookSignature} (or the same recipe in any language):
 * recompute HMAC-SHA256 over `${t}.${rawBody}` with the shared secret, compare it to
 * `v1` in constant time, and reject a `t` older than your tolerance (replay window).
 */

export const WEBHOOK_SIGNATURE_VERSION = 'v1';

export function signWebhookBody(secret: string, body: string, unixSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${unixSeconds}.${body}`, 'utf8').digest('hex');
  return `t=${unixSeconds},${WEBHOOK_SIGNATURE_VERSION}=${mac}`;
}

export interface VerifyWebhookOptions {
  /** Max age of `t` in seconds (both directions). Default 300. */
  toleranceSeconds?: number;
  /** Clock source (seconds). */
  now?: () => number;
}

export type WebhookVerifyResult =
  { ok: true; timestamp: number } | { ok: false; reason: 'malformed' | 'expired' | 'mismatch' };

/** Constant-time verification of an `x-gulley-signature` header against the raw body. */
export function verifyWebhookSignature(
  secret: string,
  header: string | undefined,
  body: string,
  opts: VerifyWebhookOptions = {},
): WebhookVerifyResult {
  if (!header) return { ok: false, reason: 'malformed' };
  let t: number | undefined;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return { ok: false, reason: 'malformed' };
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') {
      if (!/^\d{1,12}$/.test(v)) return { ok: false, reason: 'malformed' };
      t = Number(v);
    } else if (k === WEBHOOK_SIGNATURE_VERSION) {
      if (!/^[0-9a-f]{64}$/i.test(v)) return { ok: false, reason: 'malformed' };
      sigs.push(v.toLowerCase());
    }
  }
  if (t === undefined || sigs.length === 0) return { ok: false, reason: 'malformed' };
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.now ? opts.now() : Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > tolerance) return { ok: false, reason: 'expired' };
  const expected = createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest();
  for (const sig of sigs) {
    const got = Buffer.from(sig, 'hex');
    if (got.length === expected.length && timingSafeEqual(got, expected)) {
      return { ok: true, timestamp: t };
    }
  }
  return { ok: false, reason: 'mismatch' };
}

export interface WebhookDelivery {
  headers: Record<string, string>;
  body: string;
}

/** Headers + body for one attempt (the signature timestamp is per attempt). */
export function webhookDelivery(
  event: AlertEvent,
  secret: string,
  deliveryId: string,
  unixSeconds: number = Math.floor(Date.now() / 1000),
): WebhookDelivery {
  const body = JSON.stringify(event);
  return {
    headers: {
      'x-gulley-event': event.kind,
      'x-gulley-delivery': deliveryId,
      'x-gulley-signature': signWebhookBody(secret, body, unixSeconds),
      'user-agent': 'gulley-alerts',
    },
    body,
  };
}

export class WebhookChannel implements AlertChannel {
  readonly type = 'webhook';
  constructor(
    readonly name: string,
    private readonly url: string,
    private readonly secret: string,
    private readonly deps: HttpDeps & { now?: () => number },
  ) {}

  async send(event: AlertEvent, attempt: DeliveryAttempt): Promise<void> {
    const seconds = Math.floor((this.deps.now ? this.deps.now() : Date.now()) / 1000);
    const { headers, body } = webhookDelivery(event, this.secret, attempt.id, seconds);
    await postJson(this.deps, this.url, headers, body);
  }
}
