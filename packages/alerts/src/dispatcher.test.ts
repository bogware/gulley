import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlertChannelConfig } from './config';
import { AlertDispatcher, type AlertDropReason } from './dispatcher';
import { type AlertEvent, type AlertKind, makeAlert } from './types';

const ALLOW = ['hooks.slack.test', 'teams.test', 'events.pagerduty.com', 'hooks.test', 'smtp.test'];
const SECRET = 'webhook-shared-secret-16+';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
  at: number;
}

/** A scripted fetch: each entry is a status code, or a function that throws/returns. */
function scriptedFetch(script: Array<number | (() => never)>, now: () => number = Date.now) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ''),
      at: now(),
    });
    const next = script.length > 1 ? (script.shift() as number | (() => never)) : script[0];
    if (typeof next === 'function') next();
    const status = typeof next === 'number' ? next : 200;
    return { ok: status >= 200 && status < 300, status } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const slack = (extra: Partial<AlertChannelConfig> = {}): AlertChannelConfig =>
  ({
    type: 'slack',
    url: 'https://hooks.slack.test/services/T/B/x',
    ...extra,
  }) as AlertChannelConfig;

const webhook = (): AlertChannelConfig => ({
  type: 'webhook',
  url: 'https://hooks.test/gulley',
  secret: SECRET,
});

function breaker(target = 'anthropic:primary'): AlertEvent {
  return makeAlert({ kind: 'breaker.open', target, provider: 'anthropic' }, () => new Date(0));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AlertDispatcher — delivery, retry and backoff', () => {
  it('delivers once on 2xx and reports via onDelivered', async () => {
    const { calls, fetchImpl } = scriptedFetch([200]);
    const delivered: Array<[AlertKind, string, boolean]> = [];
    const d = new AlertDispatcher({
      channels: [slack()],
      egress: { allowlist: ALLOW },
      fetchImpl,
      onDelivered: (k, c, ok) => delivered.push([k, c, ok]),
    });
    d.emit(breaker());
    await d.drain();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://hooks.slack.test/services/T/B/x');
    expect(delivered).toEqual([['breaker.open', 'slack', true]]);
    expect(d.stats).toMatchObject({ emitted: 1, delivered: 1, failed: 0, pending: 0 });
  });

  it('retries 5xx / 429 / network errors with 250 ms, 1 s, 4 s backoff and gives up after 3 retries', async () => {
    vi.useFakeTimers();
    const { calls, fetchImpl } = scriptedFetch([
      503,
      429,
      () => {
        throw new TypeError('fetch failed');
      },
      200,
    ]);
    const d = new AlertDispatcher({
      channels: [webhook()],
      egress: { allowlist: ALLOW },
      fetchImpl,
      random: () => 0.5, // jitter factor exactly 1.0
    });
    const probe = d.probe(breaker());
    await vi.advanceTimersByTimeAsync(10_000);
    const [r] = await probe;
    expect(r).toMatchObject({ channel: 'webhook', ok: true, attempts: 4, filtered: false });
    const t0 = calls[0]?.at as number;
    expect(calls.map((c) => c.at - t0)).toEqual([0, 250, 1250, 5250]);
    // Same delivery id on every attempt — the consumer's dedupe handle.
    expect(new Set(calls.map((c) => c.headers['x-gulley-delivery'])).size).toBe(1);

    const persistent = scriptedFetch([503]);
    const d2 = new AlertDispatcher({
      channels: [slack()],
      egress: { allowlist: ALLOW },
      fetchImpl: persistent.fetchImpl,
      random: () => 0.5,
    });
    const probe2 = d2.probe(breaker());
    await vi.advanceTimersByTimeAsync(10_000);
    const [r2] = await probe2;
    expect(r2).toMatchObject({ ok: false, attempts: 4 });
    expect(r2?.error).toMatch(/HTTP 503/);
    expect(persistent.calls).toHaveLength(4);
  });

  it('does not retry a non-429 4xx (a permanent misconfiguration)', async () => {
    const { calls, fetchImpl } = scriptedFetch([404]);
    const warned: Array<Record<string, unknown>> = [];
    const d = new AlertDispatcher({
      channels: [slack()],
      egress: { allowlist: ALLOW },
      fetchImpl,
      log: { warn: (o) => warned.push(o) },
    });
    const [r] = await d.probe(breaker());
    expect(r).toMatchObject({ ok: false, attempts: 1 });
    expect(r?.error).toMatch(/HTTP 404/);
    expect(calls).toHaveLength(1);
    expect(warned[0]).toMatchObject({ channel: 'slack', kind: 'breaker.open', attempts: 1 });
    expect(JSON.stringify(warned)).not.toContain('hooks.slack.test/services');
  });

  it('scrubs configured URLs and secrets out of error text', async () => {
    const url = 'https://hooks.test/gulley';
    const { fetchImpl } = scriptedFetch([
      () => {
        throw new Error(`connect failed to ${url} using ${SECRET}`);
      },
    ]);
    const d = new AlertDispatcher({
      channels: [webhook()],
      egress: { allowlist: ALLOW },
      fetchImpl,
      retryDelaysMs: [],
    });
    const [r] = await d.probe(breaker());
    expect(r?.ok).toBe(false);
    expect(r?.error).not.toContain(url);
    expect(r?.error).not.toContain(SECRET);
  });
});

describe('AlertDispatcher — filters, storm control and the bounded queue', () => {
  it('applies per-channel event patterns and minSeverity', async () => {
    const { calls, fetchImpl } = scriptedFetch([200]);
    const d = new AlertDispatcher({
      channels: [slack({ events: ['budget.*', 'admin.break_glass'], minSeverity: 'warning' })],
      egress: { allowlist: ALLOW },
      fetchImpl,
    });
    const at = () => new Date(0);
    d.emit(makeAlert({ kind: 'config.applied', version: 1, contentHash: 'h', actor: 'a' }, at)); // info + not matched
    d.emit(breaker()); // critical but not matched
    d.emit(
      makeAlert(
        {
          kind: 'budget.threshold',
          scope: 'ws',
          scopeKind: 'workspace',
          entity: 'ws',
          window: 'monthly',
          threshold: 0.8,
          usedMicroUsd: 80,
          capMicroUsd: 100,
          utilization: 0.8,
        },
        at,
      ),
    ); // warning + matched
    d.emit(makeAlert({ kind: 'admin.break_glass', actor: 'x', reason: 'r', expiresAt: 'e' }, at)); // critical + matched
    await d.drain();
    expect(calls.map((c) => (JSON.parse(c.body) as { text: string }).text)).toEqual([
      expect.stringContaining('Budget threshold'),
      expect.stringContaining('Break-glass'),
    ]);
    expect(d.stats.filtered).toBe(2);
  });

  it('dedupes an identical (kind, entity) within the window, per channel', async () => {
    let now = 1_000_000;
    const { calls, fetchImpl } = scriptedFetch([200]);
    const drops: Array<[string, AlertDropReason]> = [];
    const d = new AlertDispatcher({
      channels: [slack(), { type: 'teams', url: 'https://teams.test/hook', dedupeWindowMs: 0 }],
      egress: { allowlist: ALLOW },
      fetchImpl,
      now: () => now,
      onDropped: (_k, c, reason) => drops.push([c, reason]),
    });
    d.emit(breaker('a'));
    d.emit(breaker('a')); // duplicate for slack (60 s window); teams has storm control off
    d.emit(breaker('b')); // different entity
    now += 60_001;
    d.emit(breaker('a')); // window elapsed
    await d.drain();
    const slackCalls = calls.filter((c) => c.url.includes('slack'));
    const teamsCalls = calls.filter((c) => c.url.includes('teams'));
    expect(slackCalls).toHaveLength(3);
    expect(teamsCalls).toHaveLength(4);
    expect(drops).toEqual([['slack', 'dedupe']]);
    expect(d.stats.deduped).toBe(1);
  });

  it('drops (and counts) when more than maxPending deliveries are queued', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      await gate;
      return { ok: true, status: 200 } as unknown as Response;
    }) as unknown as typeof fetch;
    const drops: AlertDropReason[] = [];
    const d = new AlertDispatcher({
      channels: [slack({ dedupeWindowMs: 0 })],
      egress: { allowlist: ALLOW },
      fetchImpl,
      maxPending: 2,
      maxConcurrency: 1,
      onDropped: (_k, _c, reason) => drops.push(reason),
    });
    for (let i = 0; i < 5; i++) d.emit(breaker(`t${i}`));
    expect(d.stats.pending).toBe(2);
    expect(drops).toEqual(['queue_full', 'queue_full', 'queue_full']);
    expect(d.stats.dropped).toBe(3);
    release();
    await d.drain();
    expect(n).toBe(2);
    expect(d.stats.pending).toBe(0);
  });

  it('labels channels by name, or type#n when a type repeats, and describes them without URLs', () => {
    const d = new AlertDispatcher({
      channels: [slack(), slack({ name: 'sec-ops' }), slack()],
      egress: { allowlist: ALLOW },
      fetchImpl: scriptedFetch([200]).fetchImpl,
    });
    expect(d.describe().map((c) => c.name)).toEqual(['slack#1', 'sec-ops', 'slack#3']);
    expect(JSON.stringify(d.describe())).not.toContain('hooks.slack.test');
    expect(d.size).toBe(3);
  });

  it('never throws from emit, even if a channel misbehaves synchronously', () => {
    const d = new AlertDispatcher({
      channels: [slack()],
      egress: { allowlist: ALLOW },
      fetchImpl: (() => {
        throw new Error('sync boom');
      }) as unknown as typeof fetch,
      retryDelaysMs: [],
    });
    expect(() => d.emit(breaker())).not.toThrow();
  });
});

describe('AlertDispatcher — egress guard at construction', () => {
  it('refuses a target off the allowlist, naming the channel but not the URL', () => {
    expect(
      () =>
        new AlertDispatcher({
          channels: [slack()],
          egress: { allowlist: ['elsewhere.test'] },
        }),
    ).toThrow(
      /^alert channel slack \(slack\): host not in outbound allowlist: hooks\.slack\.test$/,
    );
  });

  it('requires https unless the dev relaxation is set', () => {
    const plain = {
      type: 'webhook',
      url: 'http://hooks.test/x',
      secret: SECRET,
    } as AlertChannelConfig;
    expect(() => new AlertDispatcher({ channels: [plain], egress: { allowlist: ALLOW } })).toThrow(
      /non-https/,
    );
    expect(
      () =>
        new AlertDispatcher({
          channels: [plain],
          egress: { allowlist: ALLOW, requireHttps: false },
        }),
    ).not.toThrow();
  });

  it('is fail-closed when air-gapped without an allowlist', () => {
    expect(() => new AlertDispatcher({ channels: [slack()], egress: { airGapped: true } })).toThrow(
      /air-gapped/,
    );
  });

  it('guards the PagerDuty endpoint and the SMTP host like any other sink', () => {
    const pd = {
      type: 'pagerduty',
      routingKey: 'R0UT1NGK3Y0000000000000000000000',
    } as AlertChannelConfig;
    expect(
      () => new AlertDispatcher({ channels: [pd], egress: { allowlist: ['x.test'] } }),
    ).toThrow('events.pagerduty.com');
    expect(
      () => new AlertDispatcher({ channels: [pd], egress: { allowlist: ALLOW } }),
    ).not.toThrow();

    const mail = (smtpUrl: string): AlertChannelConfig =>
      ({ type: 'email', smtpUrl, from: 'g@acme.test', to: ['o@acme.test'] }) as AlertChannelConfig;
    const createMailer = () => ({ sendMail: async () => undefined });
    expect(
      () =>
        new AlertDispatcher({
          channels: [mail('smtps://u:p@10.0.0.5')],
          egress: { allowlist: ALLOW },
          createMailer,
        }),
    ).toThrow(/internal\/link-local/);
    expect(
      () =>
        new AlertDispatcher({
          channels: [mail('smtps://u:p@mail.test')],
          egress: { allowlist: ALLOW },
          createMailer,
        }),
    ).toThrow(/host not in outbound allowlist: mail\.test/);
    const err = (() => {
      try {
        new AlertDispatcher({
          channels: [mail('smtps://u:hunter2-pass@mail.test')],
          egress: { allowlist: ALLOW },
          createMailer,
        });
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    })();
    expect(err).not.toContain('hunter2');
    expect(
      () =>
        new AlertDispatcher({
          channels: [mail('smtps://u:p@smtp.test')],
          egress: { allowlist: ALLOW },
          createMailer,
        }),
    ).not.toThrow();
  });
});

describe('AlertDispatcher — probe', () => {
  it('delivers to every channel regardless of filters and reports per channel', async () => {
    const { calls, fetchImpl } = scriptedFetch([200]);
    const d = new AlertDispatcher({
      channels: [slack({ events: ['budget.*'] }), webhook()],
      egress: { allowlist: ALLOW },
      fetchImpl,
    });
    const results = await d.probe(breaker());
    expect(results).toEqual([
      { channel: 'slack', type: 'slack', ok: true, attempts: 1, filtered: true },
      { channel: 'webhook', type: 'webhook', ok: true, attempts: 1, filtered: false },
    ]);
    expect(calls).toHaveLength(2);
  });
});
