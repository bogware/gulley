import {
  type AuditEventInput,
  type AuditRow,
  type AuditSink,
  computeRowHash,
  rowContent,
} from './audit';
import {
  decodeLogCursor,
  encodeLogCursor,
  type Ledger,
  type RequestLogEntry,
  type RequestLogFilter,
  type RequestLogPage,
  type RequestLogQuery,
  type RequestLogSink,
  type SpendRecord,
  type StoredRequestLog,
  type UsageBucket,
  type UsageBucketWidth,
  type UsageQuery,
} from './ports';

export class InMemoryLedger implements Ledger {
  readonly entries: SpendRecord[] = [];

  async record(entry: SpendRecord): Promise<void> {
    this.entries.push(entry);
  }

  totalMicroUsd(): number {
    return this.entries.reduce((sum, e) => sum + e.costMicroUsd, 0);
  }
}

export class InMemoryRequestLog implements RequestLogSink, RequestLogQuery {
  readonly entries: StoredRequestLog[] = [];
  private seq = 0;

  async write(entry: RequestLogEntry): Promise<void> {
    this.entries.push({ ...entry, id: `log_${String(++this.seq).padStart(12, '0')}` });
  }

  async writeBatch(entries: RequestLogEntry[]): Promise<void> {
    for (const e of entries) await this.write(e);
  }

  async search(filter: RequestLogFilter): Promise<RequestLogPage> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    let rows = this.entries.filter((e) => logMatches(e, filter));
    // Newest first; id desc tiebreak gives a stable keyset ordering.
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || cmp(b.id, a.id));
    if (filter.cursor) {
      const c = decodeLogCursor(filter.cursor);
      if (c) {
        const ct = c.createdAt.getTime();
        rows = rows.filter(
          (e) => e.createdAt.getTime() < ct || (e.createdAt.getTime() === ct && e.id < c.id),
        );
      }
    }
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last ? encodeLogCursor(last.createdAt, last.id) : undefined;
    return { entries: page, nextCursor };
  }

  async get(requestId: string): Promise<StoredRequestLog | null> {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i] as StoredRequestLog;
      if (e.requestId === requestId) return e;
    }
    return null;
  }

  async usage(query: UsageQuery): Promise<UsageBucket[]> {
    const ws =
      query.workspaceIds && query.workspaceIds.length ? new Set(query.workspaceIds) : undefined;
    const buckets = new Map<string, UsageBucket>();
    for (const e of this.entries) {
      if (e.createdAt < query.from || e.createdAt >= query.to) continue;
      if (ws && !ws.has(e.workspaceId)) continue;
      const bucketStart = truncateBucket(e.createdAt, query.bucket).toISOString();
      const group =
        query.groupBy === 'provider'
          ? e.provider
          : query.groupBy === 'model'
            ? e.model
            : query.groupBy === 'workspace'
              ? e.workspaceId
              : undefined;
      const key = `${bucketStart}|${group ?? ''}`;
      let b = buckets.get(key);
      if (!b) {
        b = {
          bucketStart,
          ...(group !== undefined ? { group } : {}),
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          costMicroUsd: 0,
        };
        buckets.set(key, b);
      }
      b.requests += 1;
      b.inputTokens += e.inputTokens;
      b.outputTokens += e.outputTokens;
      b.costMicroUsd += e.costMicroUsd;
    }
    return [...buckets.values()].sort(
      (a, b) => cmp(a.bucketStart, b.bucketStart) || cmp(a.group ?? '', b.group ?? ''),
    );
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function logMatches(e: StoredRequestLog, f: RequestLogFilter): boolean {
  if (f.workspaceIds && f.workspaceIds.length && !f.workspaceIds.includes(e.workspaceId))
    return false;
  if (f.provider && e.provider !== f.provider) return false;
  if (f.model && e.model !== f.model) return false;
  if (f.status && e.status !== f.status) return false;
  if (f.minStatusCode !== undefined && e.statusCode < f.minStatusCode) return false;
  if (f.from && e.createdAt < f.from) return false;
  if (f.to && e.createdAt >= f.to) return false;
  return true;
}

function truncateBucket(d: Date, width: UsageBucketWidth): Date {
  const t = new Date(d);
  t.setUTCMilliseconds(0);
  t.setUTCSeconds(0);
  if (width === 'minute') return t;
  t.setUTCMinutes(0);
  if (width === 'hour') return t;
  t.setUTCHours(0);
  return t;
}

export class InMemoryAuditSink implements AuditSink {
  readonly rows: AuditRow[] = [];
  private seq = 0;
  private prevHash: string | null = null;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async append(event: AuditEventInput): Promise<AuditRow> {
    const seq = ++this.seq;
    const createdAt = this.clock();
    const content = rowContent({ seq, createdAt, ...event });
    const rowHash = computeRowHash(this.prevHash, content);
    const row: AuditRow = { ...event, seq, prevHash: this.prevHash, rowHash, createdAt };
    this.prevHash = rowHash;
    this.rows.push(row);
    return row;
  }

  /** Recompute the chain and confirm every link and prev-pointer matches. */
  verify(): boolean {
    let prev: string | null = null;
    for (const row of this.rows) {
      const content = rowContent(row);
      if (row.prevHash !== prev) return false;
      if (computeRowHash(prev, content) !== row.rowHash) return false;
      prev = row.rowHash;
    }
    return true;
  }
}
