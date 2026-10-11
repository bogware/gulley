import { createTransport } from 'nodemailer';
import { alertEntity, alertText } from '../format';
import type { AlertEvent } from '../types';
import { AlertDeliveryError, type AlertChannel, type DeliveryAttempt } from './channel';

/** What the channel needs from a mailer — nodemailer's Transporter, or a test fake. */
export interface Mailer {
  sendMail(message: MailMessage): Promise<unknown>;
  close?(): void;
}

export interface MailMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
  headers?: Record<string, string>;
}

export interface SmtpOptions {
  host: string;
  port: number;
  /** Implicit TLS (`smtps://`). */
  secure: boolean;
  /** Refuse to send unless STARTTLS upgrades a plain `smtp://` session. */
  requireTLS: boolean;
  auth?: { user: string; pass: string };
  connectionTimeoutMs: number;
}

/**
 * Parse `smtp://user:pass@host:587` / `smtps://user:pass@host:465`. Credentials come
 * from the URL userinfo (percent-decoded); the result never round-trips to a log.
 * A plain `smtp://` URL requires STARTTLS unless `allowPlaintext` (dev only).
 */
export function parseSmtpUrl(
  smtpUrl: string,
  opts: { allowPlaintext?: boolean; connectionTimeoutMs?: number } = {},
): SmtpOptions {
  let url: URL;
  try {
    url = new URL(smtpUrl);
  } catch {
    throw new Error('smtpUrl is not a URL');
  }
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') {
    throw new Error(`smtpUrl must use smtp:// or smtps:// (got ${url.protocol}//)`);
  }
  if (!url.hostname) throw new Error('smtpUrl has no host');
  const secure = url.protocol === 'smtps:';
  const port = url.port ? Number(url.port) : secure ? 465 : 587;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('smtpUrl port invalid');
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  return {
    host: url.hostname,
    port,
    secure,
    requireTLS: !secure && !opts.allowPlaintext,
    ...(user ? { auth: { user, pass } } : {}),
    connectionTimeoutMs: opts.connectionTimeoutMs ?? 5_000,
  };
}

export function defaultMailer(smtp: SmtpOptions): Mailer {
  return createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: smtp.requireTLS,
    auth: smtp.auth,
    connectionTimeout: smtp.connectionTimeoutMs,
    greetingTimeout: smtp.connectionTimeoutMs,
    socketTimeout: smtp.connectionTimeoutMs * 2,
  }) as unknown as Mailer;
}

/** Subject `[gulley] <kind>: <entity>`, plain-text body. */
export function emailMessage(event: AlertEvent, from: string, to: string[]): MailMessage {
  return {
    from,
    to,
    subject: `[gulley] ${event.kind}: ${alertEntity(event)}`,
    text: alertText(event),
    headers: {
      'x-gulley-event': event.kind,
      'x-gulley-severity': event.severity,
    },
  };
}

/** SMTP failures: 4xx replies, connection/timeout errors retry; auth, envelope and
 *  5xx replies are permanent (a retry can't fix a bad password or recipient). */
function classify(err: unknown): AlertDeliveryError {
  const e = err as { code?: string; responseCode?: number; message?: string };
  const code = e?.code ?? '';
  const rc = typeof e?.responseCode === 'number' ? e.responseCode : undefined;
  const permanent =
    code === 'EAUTH' ||
    code === 'EENVELOPE' ||
    code === 'EMESSAGE' ||
    (rc !== undefined && rc >= 500);
  const why = rc !== undefined ? `SMTP ${rc}` : code || 'SMTP error';
  return new AlertDeliveryError(`mail failed: ${why}`, !permanent, rc);
}

export class EmailChannel implements AlertChannel {
  readonly type = 'email';
  private readonly mailer: Mailer;

  constructor(
    readonly name: string,
    smtp: SmtpOptions,
    private readonly from: string,
    private readonly to: string[],
    createMailer: (smtp: SmtpOptions) => Mailer = defaultMailer,
  ) {
    this.mailer = createMailer(smtp);
  }

  async send(event: AlertEvent, _attempt: DeliveryAttempt): Promise<void> {
    try {
      await this.mailer.sendMail(emailMessage(event, this.from, this.to));
    } catch (err) {
      throw classify(err);
    }
  }

  close(): void {
    this.mailer.close?.();
  }
}
