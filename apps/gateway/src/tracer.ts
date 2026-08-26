/**
 * A bounded, in-memory live request tracer. The teardown feeds one small,
 * credential-free summary per proxied request; the /debug/trace SSE endpoint
 * replays the recent ring and then streams new events to a connected operator.
 * Purely in-process (per replica) and lossy by design — a debugging aid, never a
 * durable audit sink (that is the hash-chained audit trail).
 */
export interface TraceEvent {
  requestId: string;
  traceId?: string;
  principalId: string;
  provider: string;
  model: string;
  status: string;
  statusCode: number;
  streamed: boolean;
  latencyMs: number;
  costMicroUsd: number;
  cache?: string;
  guardrailAction?: string;
  ts: number;
}

export class RequestTracer {
  private readonly ring: TraceEvent[] = [];
  private readonly subscribers = new Set<(e: TraceEvent) => void>();

  constructor(private readonly capacity = 200) {}

  record(event: TraceEvent): void {
    this.ring.push(event);
    if (this.ring.length > this.capacity) this.ring.shift();
    for (const cb of this.subscribers) {
      try {
        cb(event);
      } catch {
        /* a slow/broken subscriber must never break metering */
      }
    }
  }

  /** Snapshot of the recent ring (oldest first). */
  recent(): TraceEvent[] {
    return [...this.ring];
  }

  /** Subscribe to live events; returns an unsubscribe function. */
  subscribe(cb: (e: TraceEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
