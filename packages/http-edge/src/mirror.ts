/**
 * Request mirroring (shadow traffic): a sampled, fire-and-forget copy of the
 * request sent to a second endpoint — for load-testing a new provider, comparing
 * responses, or capturing a corpus, without affecting the real request. It is
 * fully detached: its own AbortController + timeout (never the client's), the
 * response is drained and discarded, and every error is swallowed. It is NEVER
 * awaited by the hot path and never touches metering/budget/ledger, so shadow
 * traffic can't slow, fail, or double-charge the real request.
 *
 * SECURITY: the mirror target's own auth is supplied via `headers` (operator
 * config); the caller must send an already-effective (masked/shaped) body so the
 * shadow never leaks what a guardrail redacted. The URL should be egress-guarded
 * by the caller at construction, like any operator-supplied outbound URL.
 */
export interface RequestMirrorConfig {
  url: string;
  /** Fraction of requests to mirror, 0..1. */
  sampleRate: number;
  /** Static headers for the shadow request (e.g. the shadow endpoint's auth). */
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  rand?: () => number;
}

export class RequestMirror {
  private readonly url: string;
  private readonly sampleRate: number;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly rand: () => number;

  constructor(cfg: RequestMirrorConfig) {
    this.url = cfg.url;
    this.sampleRate = cfg.sampleRate;
    this.headers = cfg.headers ?? {};
    this.timeoutMs = cfg.timeoutMs ?? 5000;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.rand = cfg.rand ?? Math.random;
  }

  /** Maybe fire a shadow request. Returns true if it sampled+dispatched (for
   *  observability/tests); never blocks and never throws. */
  fire(body: Buffer | string): boolean {
    if (this.sampleRate <= 0 || this.rand() >= this.sampleRate) return false;
    void this.send(body);
    return true;
  }

  private async send(body: Buffer | string): Promise<void> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers },
        body,
        signal: ac.signal,
      } as Parameters<typeof fetch>[1]);
      // Drain the body so the connection is released back to the pool.
      try {
        await res.arrayBuffer();
      } catch {
        /* ignore */
      }
    } catch {
      /* shadow traffic is best-effort — swallow everything */
    } finally {
      clearTimeout(timer);
    }
  }
}
