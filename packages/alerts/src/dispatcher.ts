import { randomUUID } from 'node:crypto';
import { assertEgressAllowed, type EgressOptions } from '@gulley/egress';
import {
  type AlertChannel,
  AlertDeliveryError,
  EmailChannel,
  type Mailer,
  PAGERDUTY_EVENTS_URL,
  PagerDutyChannel,
  parseSmtpUrl,
  SlackChannel,
  type SmtpOptions,
  TeamsChannel,
  WebhookChannel,
} from './channels';
import { type AlertChannelConfig, matchesEventPattern } from './config';
import { alertEntity } from './format';
import type { AlertProbe, AlertProbeResult, AlertSink } from './sink';
import { type AlertEvent, type AlertKind, type AlertSeverity, severityRank } from './types';

export type AlertDropReason = 'queue_full' | 'dedupe';

/** pino-compatible: `warn(obj, msg)`. */
export interface AlertLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  info?(obj: Record<string, unknown>, msg: string): void;
}

export interface AlertDispatcherOptions {
  channels: AlertChannelConfig[];
  /** The same guard every control-plane outbound uses: allowlist, requireHttps outside
   *  dev, air-gapped posture. Checked ONCE per channel at construction (fail boot on a
   *  bad target), and the fetch itself should be DNS-pinned (`pinnedFetch()`). */
  egress?: EgressOptions;
  fetchImpl?: typeof fetch;
  /** Per-attempt HTTP/SMTP deadline. Default 5 000 ms. */
  timeoutMs?: number;
  /** Deliveries (event × channel) allowed in flight or queued; beyond it, drop + count.
   *  Default 1 000. */
  maxPending?: number;
  /** Concurrent deliveries. Default 8. */
  maxConcurrency?: number;
  /** Backoff before retry n (jittered ×0.5–1.5). Default [250, 1000, 4000] = up to 3 retries. */
  retryDelaysMs?: readonly number[];
  /** Default per-channel storm-control window. Default 60 000 ms (PagerDuty: 0). */
  dedupeWindowMs?: number;
  /** Metrics hook per finished delivery. */
  onDelivered?: (kind: AlertKind, channel: string, ok: boolean) => void;
  /** Metrics hook per drop (queue full / storm control). */
  onDropped?: (kind: AlertKind, channel: string, reason: AlertDropReason) => void;
  log?: AlertLogger;
  now?: () => number;
  /** Jitter source in [0, 1). */
  random?: () => number;
  /** Mailer factory (tests inject a fake; default nodemailer SMTP). */
  createMailer?: (smtp: SmtpOptions) => Mailer;
  /** PagerDuty `payload.source` (e.g. `gulley-gateway`). */
  source?: string;
  /** Override the PagerDuty Events endpoint (tests). */
  pagerdutyUrl?: string;
}

export interface AlertDispatcherStats {
  emitted: number;
  delivered: number;
  failed: number;
  /** Queue-full drops. */
  dropped: number;
  /** Storm-control drops. */
  deduped: number;
  /** Channel filter skips (not an error). */
  filtered: number;
  pending: number;
}

export interface AlertChannelDescription {
  name: string;
  type: string;
  events: string[] | undefined;
  minSeverity: AlertSeverity;
  dedupeWindowMs: number;
}

interface Bound {
  channel: AlertChannel;
  events: string[] | undefined;
  minSeverity: AlertSeverity;
  dedupeWindowMs: number;
  lastSent: Map<string, number>;
}

interface DeliveryOutcome {
  ok: boolean;
  attempts: number;
  error?: string;
}

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 4_000];
const DEDUPE_MAP_CAP = 10_000;

/**
 * Fans every event out to the configured channels with retry, storm control and a
 * bounded queue. `emit` never throws and never blocks the caller: delivery runs on a
 * small worker pool off the emitter's path. Never logs a URL or a key — channels are
 * referred to by label, and error text is scrubbed against every configured secret.
 */
export class AlertDispatcher implements AlertSink, AlertProbe {
  private readonly bound: Bound[] = [];
  private readonly queue: Array<() => Promise<void>> = [];
  private running = 0;
  private pending = 0;
  private readonly secrets: string[] = [];
  private readonly maxPending: number;
  private readonly maxConcurrency: number;
  private readonly retryDelays: readonly number[];
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly log: AlertLogger | undefined;
  private readonly onDelivered: AlertDispatcherOptions['onDelivered'];
  private readonly onDropped: AlertDispatcherOptions['onDropped'];
  readonly stats: AlertDispatcherStats = {
    emitted: 0,
    delivered: 0,
    failed: 0,
    dropped: 0,
    deduped: 0,
    filtered: 0,
    pending: 0,
  };

  constructor(opts: AlertDispatcherOptions) {
    this.maxPending = opts.maxPending ?? 1_000;
    this.maxConcurrency = Math.max(1, opts.maxConcurrency ?? 8);
    this.retryDelays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.log = opts.log;
    this.onDelivered = opts.onDelivered;
    this.onDropped = opts.onDropped;
    const egress = opts.egress ?? {};
    const http = { fetchImpl: opts.fetchImpl ?? fetch, timeoutMs: opts.timeoutMs ?? 5_000 };
    const labels = channelLabels(opts.channels);

    // Collect secrets FIRST so even a construction error is scrubbed before it escapes.
    for (const cfg of opts.channels) {
      if ('url' in cfg) this.secrets.push(cfg.url);
      if (cfg.type === 'pagerduty') this.secrets.push(cfg.routingKey);
      if (cfg.type === 'webhook') this.secrets.push(cfg.secret);
      if (cfg.type === 'email') this.secrets.push(cfg.smtpUrl);
    }

    opts.channels.forEach((cfg, i) => {
      const name = labels[i] as string;
      try {
        const channel = this.build(cfg, name, egress, http, opts);
        this.bound.push({
          channel,
          events: cfg.events,
          minSeverity: cfg.minSeverity ?? 'info',
          dedupeWindowMs:
            cfg.dedupeWindowMs ?? (cfg.type === 'pagerduty' ? 0 : (opts.dedupeWindowMs ?? 60_000)),
          lastSent: new Map(),
        });
      } catch (err) {
        throw new Error(`alert channel ${name} (${cfg.type}): ${this.scrub(err)}`);
      }
    });
  }

  private build(
    cfg: AlertChannelConfig,
    name: string,
    egress: EgressOptions,
    http: { fetchImpl: typeof fetch; timeoutMs: number },
    opts: AlertDispatcherOptions,
  ): AlertChannel {
    switch (cfg.type) {
      case 'slack':
        assertEgressAllowed(cfg.url, egress);
        return new SlackChannel(name, cfg.url, http);
      case 'teams':
        assertEgressAllowed(cfg.url, egress);
        return new TeamsChannel(name, cfg.url, http);
      case 'pagerduty': {
        const url = opts.pagerdutyUrl ?? PAGERDUTY_EVENTS_URL;
        assertEgressAllowed(url, egress);
        return new PagerDutyChannel(name, cfg.routingKey, {
          ...http,
          url,
          severityMap: cfg.severityMap,
          source: opts.source,
        });
      }
      case 'webhook':
        assertEgressAllowed(cfg.url, egress);
        return new WebhookChannel(name, cfg.url, cfg.secret, { ...http, now: this.now });
      case 'email': {
        const smtp = parseSmtpUrl(cfg.smtpUrl, {
          allowPlaintext: egress.requireHttps === false,
          connectionTimeoutMs: http.timeoutMs,
        });
        if (smtp.auth) this.secrets.push(smtp.auth.pass);
        // The SMTP host goes through the SAME allowlist / air-gap / internal-address
        // guard as an https sink (scheme aside — TLS is enforced by requireTLS/smtps).
        assertEgressAllowed(`https://${smtp.host}:${smtp.port}/`, {
          ...egress,
          requireHttps: true,
        });
        return new EmailChannel(name, smtp, cfg.from, cfg.to, opts.createMailer);
      }
    }
  }

  /** Number of configured channels. */
  get size(): number {
    return this.bound.length;
  }

  describe(): AlertChannelDescription[] {
    return this.bound.map((b) => ({
      name: b.channel.name,
      type: b.channel.type,
      events: b.events ? [...b.events] : undefined,
      minSeverity: b.minSeverity,
      dedupeWindowMs: b.dedupeWindowMs,
    }));
  }

  emit(event: AlertEvent): void {
    try {
      this.stats.emitted += 1;
      for (const b of this.bound) {
        if (!this.accepts(b, event)) {
          this.stats.filtered += 1;
          continue;
        }
        if (this.isDuplicate(b, event)) {
          this.stats.deduped += 1;
          this.onDropped?.(event.kind, b.channel.name, 'dedupe');
          continue;
        }
        if (this.pending >= this.maxPending) {
          this.stats.dropped += 1;
          this.onDropped?.(event.kind, b.channel.name, 'queue_full');
          continue;
        }
        this.enqueue(async () => {
          const r = await this.deliver(b, event, randomUUID());
          this.report(b, event, r);
        });
      }
    } catch (err) {
      // A sink must never throw into an emitter — not even on a bug in here.
      this.log?.warn({ err: this.scrub(err), kind: event.kind }, 'alert emit failed');
    }
  }

  /** Deliver one event to EVERY channel right now (filters and storm control bypassed)
   *  and report per channel — the admin "send a test alert" path. */
  async probe(event: AlertEvent): Promise<AlertProbeResult[]> {
    return Promise.all(
      this.bound.map(async (b): Promise<AlertProbeResult> => {
        const r = await this.deliver(b, event, randomUUID());
        this.report(b, event, r);
        return {
          channel: b.channel.name,
          type: b.channel.type,
          ok: r.ok,
          attempts: r.attempts,
          filtered: !this.accepts(b, event),
          ...(r.error ? { error: r.error } : {}),
        };
      }),
    );
  }

  /** Wait (bounded) for in-flight deliveries, then release channel resources. */
  async drain(timeoutMs = 2_000): Promise<void> {
    const deadline = this.now() + timeoutMs;
    while (this.pending > 0 && this.now() < deadline) {
      await new Promise((r) => {
        const t = setTimeout(r, 25);
        t.unref?.();
      });
    }
    this.close();
  }

  close(): void {
    for (const b of this.bound) b.channel.close?.();
  }

  private accepts(b: Bound, event: AlertEvent): boolean {
    return (
      severityRank(event.severity) >= severityRank(b.minSeverity) &&
      matchesEventPattern(event.kind, b.events)
    );
  }

  /** Check-and-mark: the first (kind, entity) in a window wins; the rest are dropped. */
  private isDuplicate(b: Bound, event: AlertEvent): boolean {
    if (b.dedupeWindowMs <= 0) return false;
    const key = `${event.kind}:${alertEntity(event)}`;
    const now = this.now();
    const last = b.lastSent.get(key);
    if (last !== undefined && now - last < b.dedupeWindowMs) return true;
    if (b.lastSent.size >= DEDUPE_MAP_CAP) {
      for (const [k, t] of b.lastSent) if (now - t >= b.dedupeWindowMs) b.lastSent.delete(k);
      if (b.lastSent.size >= DEDUPE_MAP_CAP) b.lastSent.clear(); // a 10k-entity storm: reset
    }
    b.lastSent.set(key, now);
    return false;
  }

  private enqueue(task: () => Promise<void>): void {
    this.pending += 1;
    this.stats.pending = this.pending;
    this.queue.push(task);
    this.pump();
  }

  private pump(): void {
    while (this.running < this.maxConcurrency && this.queue.length > 0) {
      const task = this.queue.shift() as () => Promise<void>;
      this.running += 1;
      void task()
        .catch(() => {
          /* deliver() never throws; belt and braces */
        })
        .finally(() => {
          this.running -= 1;
          this.pending -= 1;
          this.stats.pending = this.pending;
          this.pump();
        });
    }
  }

  private async deliver(b: Bound, event: AlertEvent, id: string): Promise<DeliveryOutcome> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await b.channel.send(event, { id, attempt });
        return { ok: true, attempts: attempt };
      } catch (err) {
        const retryable = err instanceof AlertDeliveryError ? err.retryable : true;
        const delay = this.retryDelays[attempt - 1];
        if (!retryable || delay === undefined) {
          return { ok: false, attempts: attempt, error: this.scrub(err) };
        }
        await this.sleep(delay * (0.5 + this.random()));
      }
    }
  }

  private report(b: Bound, event: AlertEvent, r: DeliveryOutcome): void {
    if (r.ok) this.stats.delivered += 1;
    else this.stats.failed += 1;
    try {
      this.onDelivered?.(event.kind, b.channel.name, r.ok);
    } catch {
      /* a metrics hook must not break delivery accounting */
    }
    if (!r.ok) {
      this.log?.warn(
        {
          channel: b.channel.name,
          type: b.channel.type,
          kind: event.kind,
          attempts: r.attempts,
          error: r.error,
        },
        'alert delivery failed',
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, Math.max(0, Math.round(ms)));
      t.unref?.();
    });
  }

  /** Error text with every configured secret/URL removed and the length bounded. */
  private scrub(err: unknown): string {
    let msg = err instanceof Error ? err.message : String(err);
    for (const s of this.secrets) {
      if (s.length >= 8) msg = msg.split(s).join('[redacted]');
    }
    return msg.slice(0, 300);
  }
}

/** `name` when configured, else `type` (or `type#n` when a type repeats); unique. */
function channelLabels(channels: readonly AlertChannelConfig[]): string[] {
  const perType = new Map<string, number>();
  for (const c of channels) perType.set(c.type, (perType.get(c.type) ?? 0) + 1);
  const seenType = new Map<string, number>();
  const used = new Set<string>();
  return channels.map((c) => {
    const n = (seenType.get(c.type) ?? 0) + 1;
    seenType.set(c.type, n);
    let label = c.name ?? ((perType.get(c.type) ?? 1) > 1 ? `${c.type}#${n}` : c.type);
    while (used.has(label)) label = `${label}#${n}`;
    used.add(label);
    return label;
  });
}
