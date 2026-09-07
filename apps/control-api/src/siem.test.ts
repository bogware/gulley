import { type AuditRow, InMemoryAuditSink } from '@gulley/pipeline';
import { describe, expect, it } from 'vitest';
import {
  buildSiemConnector,
  formatAuditEvent,
  HttpWebhookConnector,
  type SiemConnector,
  type SiemEvent,
  SentinelConnector,
  SiemExporter,
  SplunkHecConnector,
} from './siem';

async function rows(n: number): Promise<AuditRow[]> {
  const sink = new InMemoryAuditSink(() => new Date('2026-01-01T00:00:00.000Z'));
  for (let i = 0; i < n; i++)
    await sink.append({ actor: 'admin', action: `act.${i}`, target: `t${i}` });
  return sink.rows;
}

/** Capture the args of a single POST for assertions. */
function capture(): { calls: Array<{ url: string; init: RequestInit }>; fetchImpl: typeof fetch } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return { ok: true, status: 200 } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const ALLOW = ['siem.test', 'ws.ods.opinsights.azure.com'];

describe('formatAuditEvent', () => {
  it('flattens a row and carries the hash-chain provenance', async () => {
    const [r0, r1] = await rows(2);
    const e = formatAuditEvent(r1!);
    expect(e).toMatchObject({
      seq: 2,
      action: 'act.1',
      actor: 'admin',
      rowHash: r1!.rowHash,
      prevHash: r0!.rowHash, // chain link preserved
    });
    expect(e.time).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('HttpWebhookConnector', () => {
  it('POSTs { events } with the optional auth header, egress-guarded', async () => {
    const { calls, fetchImpl } = capture();
    const c = new HttpWebhookConnector('https://siem.test/ingest', {
      allowlist: ALLOW,
      fetchImpl,
      authorization: 'Bearer xyz',
    });
    const events = (await rows(2)).map(formatAuditEvent);
    await c.send(events);
    expect(calls[0]?.url).toBe('https://siem.test/ingest');
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe('Bearer xyz');
    expect(
      (JSON.parse(String(calls[0]?.init.body)) as { events: SiemEvent[] }).events,
    ).toHaveLength(2);
  });

  it('is SSRF-guarded (host not allowlisted rejects)', async () => {
    const c = new HttpWebhookConnector('https://evil.test/x', { allowlist: ALLOW });
    await expect(c.send([])).rejects.toThrow();
  });
});

describe('SplunkHecConnector', () => {
  it('sends newline-delimited HEC events with the Splunk token', async () => {
    const { calls, fetchImpl } = capture();
    const c = new SplunkHecConnector('https://siem.test/services/collector', 'tok', {
      allowlist: ALLOW,
      fetchImpl,
    });
    await c.send((await rows(2)).map(formatAuditEvent));
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe('Splunk tok');
    const lines = String(calls[0]?.init.body).trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as { sourcetype: string; event: SiemEvent };
    expect(first.sourcetype).toBe('gulley:audit');
    expect(first.event.seq).toBe(1);
  });
});

describe('SentinelConnector', () => {
  it('signs the Data Collector request with a SharedKey HMAC', async () => {
    const { calls, fetchImpl } = capture();
    const c = new SentinelConnector('ws', Buffer.from('secret').toString('base64'), {
      allowlist: ['ws.ods.opinsights.azure.com'],
      fetchImpl,
    });
    await c.send((await rows(1)).map(formatAuditEvent));
    expect(calls[0]?.url).toContain('https://ws.ods.opinsights.azure.com/api/logs');
    const h = calls[0]?.init.headers as Record<string, string>;
    expect(h['authorization']).toMatch(/^SharedKey ws:/);
    expect(h['log-type']).toBe('GulleyAudit');
    expect(h['x-ms-date']).toBeTruthy();
  });
});

describe('SiemExporter', () => {
  const fakeConnector = (): { sent: SiemEvent[][]; connector: SiemConnector; fail: () => void } => {
    let failing = false;
    const sent: SiemEvent[][] = [];
    return {
      sent,
      fail: () => (failing = true),
      connector: {
        kind: 'fake',
        send: async (events) => {
          if (failing) throw new Error('sink down');
          sent.push(events);
        },
      },
    };
  };

  it('seedFromHead skips the backlog, then tails only new events', async () => {
    const sink = new InMemoryAuditSink();
    for (let i = 0; i < 3; i++) await sink.append({ actor: 'a', action: `x${i}` });
    const fc = fakeConnector();
    const exp = new SiemExporter({ connector: fc.connector, readRows: async () => sink.rows });
    await exp.seedFromHead();
    expect((await exp.export()).exported).toBe(0); // nothing new
    await sink.append({ actor: 'a', action: 'new' });
    const r = await exp.export();
    expect(r).toEqual({ exported: 1, lastSeq: 4 });
    expect(fc.sent[0]?.[0]?.action).toBe('new');
  });

  it('exports contiguously, batches, and is idempotent', async () => {
    const src = await rows(5);
    const fc = fakeConnector();
    const exp = new SiemExporter({
      connector: fc.connector,
      readRows: async () => src,
      batchMax: 2,
    });
    expect((await exp.export()).exported).toBe(5); // 3 batches (2+2+1)
    expect(fc.sent.map((b) => b.length)).toEqual([2, 2, 1]);
    expect(await exp.export()).toEqual({ exported: 0, lastSeq: 5 }); // nothing new
  });

  it('does NOT advance the cursor when a batch fails (at-least-once)', async () => {
    const src = await rows(3);
    const fc = fakeConnector();
    const exp = new SiemExporter({ connector: fc.connector, readRows: async () => src });
    fc.fail();
    await expect(exp.export()).rejects.toThrow(/sink down/);
    expect(exp.lastExportedSeq).toBe(0); // cursor unmoved → retried next time
  });
});

describe('buildSiemConnector', () => {
  it('returns undefined when off and throws on a missing credential', () => {
    expect(buildSiemConnector({}, {})).toBeUndefined();
    expect(() => buildSiemConnector({ kind: 'splunk', url: 'https://x' }, {})).toThrow(
      /SIEM_TOKEN/,
    );
    expect(() => buildSiemConnector({ kind: 'sentinel' }, {})).toThrow(/SIEM_WORKSPACE_ID/);
    expect(() => buildSiemConnector({ kind: 'webhook' }, {})).toThrow(/SIEM_URL/);
    expect(() => buildSiemConnector({ kind: 'bogus' }, {})).toThrow(/unknown SIEM_KIND/);
  });

  it('builds each connector kind', () => {
    expect(buildSiemConnector({ kind: 'webhook', url: 'https://x' }, {})?.kind).toBe('webhook');
    expect(buildSiemConnector({ kind: 'splunk', url: 'https://x', token: 't' }, {})?.kind).toBe(
      'splunk',
    );
    expect(
      buildSiemConnector({ kind: 'sentinel', workspaceId: 'w', sharedKey: 'k' }, {})?.kind,
    ).toBe('sentinel');
  });
});
