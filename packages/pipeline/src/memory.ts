import {
  type AuditEventInput,
  type AuditRow,
  type AuditSink,
  computeRowHash,
  rowContent,
} from './audit';
import type { Ledger, RequestLogEntry, RequestLogSink, SpendRecord } from './ports';

export class InMemoryLedger implements Ledger {
  readonly entries: SpendRecord[] = [];

  async record(entry: SpendRecord): Promise<void> {
    this.entries.push(entry);
  }

  totalMicroUsd(): number {
    return this.entries.reduce((sum, e) => sum + e.costMicroUsd, 0);
  }
}

export class InMemoryRequestLog implements RequestLogSink {
  readonly entries: RequestLogEntry[] = [];

  async write(entry: RequestLogEntry): Promise<void> {
    this.entries.push(entry);
  }
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
