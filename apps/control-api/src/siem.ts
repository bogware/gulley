import { createHmac } from 'node:crypto';
import { assertEgressAllowed } from '@gulley/egress';
import type { AuditRow } from '@gulley/pipeline';

/**
 * SIEM connectors — stream the tamper-evident audit trail to the tools auditors and
 * SOC teams already watch (Splunk, Microsoft Sentinel, a generic HTTP sink). The
 * hash-chain provenance (`seq`, `rowHash`, `prevHash`) rides along on every event, so a
 * consumer can independently verify the feed is gapless + un-tampered.
 *
 * Delivery is a live TAIL of NEW audit events (the exporter seeds its cursor from the
 * current head on startup); historical/backfill export is the WORM mirror + evidence
 * bundle, not this. At-least-once: a failed batch is retried from the last cursor, so a
 * consumer should key on `seq`/`rowHash` to dedupe. Egress is SSRF-guarded.
 */
export interface SiemEvent {
  time: string;
  seq: number;
  action: string;
  actor: string | null;
  orgId: string | null;
  target: string | null;
  payload: Record<string, unknown>;
  rowHash: string;
  prevHash: string | null;
}

/** Flatten an audit row into a SIEM event (non-PII metadata — payloads are already
 *  redacted upstream by GuardedAuditSink). */
export function formatAuditEvent(row: AuditRow): SiemEvent {
  return {
    time: row.createdAt.toISOString(),
    seq: row.seq,
    action: row.action,
    actor: row.actor ?? null,
    orgId: row.orgId ?? null,
    target: row.target ?? null,
    payload: row.payload ?? {},
    rowHash: row.rowHash,
    prevHash: row.prevHash,
  };
}

export interface SiemConnector {
  readonly kind: string;
  send(events: SiemEvent[]): Promise<void>;
}

export interface HttpConnectorOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  allowlist?: ReadonlySet<string> | readonly string[];
}

/** One SSRF-guarded JSON POST with a bounded timeout, shared by every HTTP connector. */
async function postJson(
  url: string,
  headers: Record<string, string>,
  body: string,
  opts: HttpConnectorOptions,
): Promise<void> {
  assertEgressAllowed(url, { allowlist: opts.allowlist });
  const doFetch = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  timer.unref?.();
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`SIEM sink returned ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Generic HTTP sink: POST `{ events: [...] }` with an optional Authorization header. */
export class HttpWebhookConnector implements SiemConnector {
  readonly kind = 'webhook';
  constructor(
    private readonly url: string,
    private readonly opts: HttpConnectorOptions & { authorization?: string } = {},
  ) {}
  async send(events: SiemEvent[]): Promise<void> {
    await postJson(
      this.url,
      this.opts.authorization ? { authorization: this.opts.authorization } : {},
      JSON.stringify({ events }),
      this.opts,
    );
  }
}

/** Splunk HTTP Event Collector. Body is newline-delimited `{event,...}` objects (HEC's
 *  batch format), auth via `Authorization: Splunk <token>`. */
export class SplunkHecConnector implements SiemConnector {
  readonly kind = 'splunk';
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly opts: HttpConnectorOptions = {},
  ) {}
  async send(events: SiemEvent[]): Promise<void> {
    const body = events
      .map((e) =>
        JSON.stringify({
          time: Math.floor(new Date(e.time).getTime() / 1000),
          source: 'gulley',
          sourcetype: 'gulley:audit',
          event: e,
        }),
      )
      .join('\n');
    await postJson(this.url, { authorization: `Splunk ${this.token}` }, body, this.opts);
  }
}

/** Microsoft Sentinel via the Log Analytics Data Collector API (shared-key HMAC). */
export class SentinelConnector implements SiemConnector {
  readonly kind = 'sentinel';
  constructor(
    private readonly workspaceId: string,
    private readonly sharedKey: string,
    private readonly opts: HttpConnectorOptions & { logType?: string } = {},
  ) {}

  async send(events: SiemEvent[]): Promise<void> {
    const body = JSON.stringify(events);
    const date = new Date().toUTCString();
    const contentLength = Buffer.byteLength(body, 'utf8');
    // The Data Collector API signs a canonical string with the base64-decoded key.
    const toSign = `POST\n${contentLength}\napplication/json\nx-ms-date:${date}\n/api/logs`;
    const signature = createHmac('sha256', Buffer.from(this.sharedKey, 'base64'))
      .update(toSign, 'utf8')
      .digest('base64');
    const url = `https://${this.workspaceId}.ods.opinsights.azure.com/api/logs?api-version=2016-04-01`;
    await postJson(
      url,
      {
        authorization: `SharedKey ${this.workspaceId}:${signature}`,
        'log-type': this.opts.logType ?? 'GulleyAudit',
        'x-ms-date': date,
        'time-generated-field': 'time',
      },
      body,
      this.opts,
    );
  }
}

export interface SiemExporterDeps {
  connector: SiemConnector;
  /** The complete durable audit chain, seq-ascending (readAuditRows(db)). */
  readRows: () => Promise<AuditRow[]>;
  /** Max events per SIEM POST. Default 200. */
  batchMax?: number;
  log?: (msg: string) => void;
}

export interface SiemExportResult {
  exported: number;
  lastSeq: number;
}

/**
 * Tails new audit rows to a SIEM connector, tracking the last-exported seq. Seed the
 * cursor from the current head (seedFromHead) at startup so it forwards only NEW events;
 * a batch that fails to send does NOT advance the cursor (at-least-once). Single-flight.
 */
export class SiemExporter {
  private cursor = 0;
  private inFlight = false;

  constructor(private readonly deps: SiemExporterDeps) {}

  get lastExportedSeq(): number {
    return this.cursor;
  }
  get kind(): string {
    return this.deps.connector.kind;
  }

  /** Skip the existing backlog: forward only events appended after this point. */
  async seedFromHead(): Promise<void> {
    const rows = await this.deps.readRows();
    this.cursor = rows.reduce((max, r) => (r.seq > max ? r.seq : max), 0);
  }

  async export(): Promise<SiemExportResult> {
    if (this.inFlight) return { exported: 0, lastSeq: this.cursor };
    this.inFlight = true;
    try {
      const rows = await this.deps.readRows();
      const pending = rows.filter((r) => r.seq > this.cursor).sort((a, b) => a.seq - b.seq);
      if (pending.length === 0) return { exported: 0, lastSeq: this.cursor };
      const max = this.deps.batchMax ?? 200;
      let exported = 0;
      for (let i = 0; i < pending.length; i += max) {
        const chunk = pending.slice(i, i + max);
        // Send BEFORE advancing the cursor — a throw here leaves the cursor at the last
        // delivered batch so the next run retries from there (at-least-once).
        await this.deps.connector.send(chunk.map(formatAuditEvent));
        exported += chunk.length;
        this.cursor = chunk[chunk.length - 1]!.seq;
      }
      this.deps.log?.(`SIEM: exported ${exported} audit event(s) up to seq ${this.cursor}`);
      return { exported, lastSeq: this.cursor };
    } finally {
      this.inFlight = false;
    }
  }
}

/** Build the configured SIEM connector, or undefined when SIEM export is off. Throws on
 *  an unknown kind or missing required credential so a misconfig fails boot. */
export function buildSiemConnector(
  config: {
    kind?: string;
    url?: string;
    token?: string;
    workspaceId?: string;
    sharedKey?: string;
    authorization?: string;
    logType?: string;
  },
  opts: HttpConnectorOptions,
): SiemConnector | undefined {
  switch (config.kind) {
    case undefined:
    case '':
      return undefined;
    case 'webhook':
      if (!config.url) throw new Error('SIEM_URL required for SIEM_KIND=webhook');
      return new HttpWebhookConnector(config.url, {
        ...opts,
        ...(config.authorization ? { authorization: config.authorization } : {}),
      });
    case 'splunk':
      if (!config.url || !config.token) {
        throw new Error('SIEM_URL + SIEM_TOKEN required for SIEM_KIND=splunk');
      }
      return new SplunkHecConnector(config.url, config.token, opts);
    case 'sentinel':
      if (!config.workspaceId || !config.sharedKey) {
        throw new Error('SIEM_WORKSPACE_ID + SIEM_SHARED_KEY required for SIEM_KIND=sentinel');
      }
      return new SentinelConnector(config.workspaceId, config.sharedKey, {
        ...opts,
        ...(config.logType ? { logType: config.logType } : {}),
      });
    default:
      throw new Error(`unknown SIEM_KIND: ${config.kind}`);
  }
}
