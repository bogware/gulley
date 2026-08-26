import type { RequestLogEntry, RequestLogSink } from './ports';

export interface BatchingOptions {
  /** Flush once this many entries are buffered. Default 100. */
  maxBatch?: number;
  /** Flush a partial batch after this long. Default 1000ms. */
  intervalMs?: number;
  /** Called if a flush fails, so the host can log the dropped count. */
  onError?: (err: unknown, dropped: number) => void;
}

/**
 * Buffers request-log writes and flushes them in batches, keeping the hot-path
 * teardown off the database round-trip. The durable spend ledger is written
 * synchronously elsewhere; this is only the operational log, so a lost flush
 * under failure degrades analytics, never billing. Flush on size, on an interval,
 * and on `close()` (wired to the SIGTERM drain).
 */
export class BatchingRequestLog implements RequestLogSink {
  private buf: RequestLogEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing = false;
  private readonly maxBatch: number;
  private readonly intervalMs: number;

  constructor(
    private readonly sink: RequestLogSink,
    private readonly opts: BatchingOptions = {},
  ) {
    this.maxBatch = opts.maxBatch ?? 100;
    this.intervalMs = opts.intervalMs ?? 1000;
  }

  async write(entry: RequestLogEntry): Promise<void> {
    this.buf.push(entry);
    if (this.buf.length >= this.maxBatch) void this.flush();
    else this.arm();
  }

  /** Entries buffered but not yet flushed (a backlog gauge for metrics). */
  backlog(): number {
    return this.buf.length;
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), this.intervalMs);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.flushing || this.buf.length === 0) return;
    this.flushing = true;
    const batch = this.buf;
    this.buf = [];
    try {
      if (this.sink.writeBatch) await this.sink.writeBatch(batch);
      else for (const e of batch) await this.sink.write(e);
    } catch (err) {
      // Don't re-buffer unbounded — drop and let the host log the loss.
      this.opts.onError?.(err, batch.length);
    } finally {
      this.flushing = false;
      if (this.buf.length > 0) this.arm();
    }
  }

  /** Flush the remainder and stop the timer (call on shutdown). */
  async close(): Promise<void> {
    await this.flush();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
