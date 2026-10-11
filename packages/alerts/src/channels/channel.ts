import type { AlertEvent } from '../types';

/** A failed delivery attempt. `retryable` drives the dispatcher's backoff: network
 *  errors, timeouts, 429 and 5xx retry; any other 4xx is a permanent misconfiguration. */
export class AlertDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AlertDeliveryError';
  }
}

export interface DeliveryAttempt {
  /** Stable per event × channel across retries (the consumer's dedupe handle). */
  id: string;
  /** 1-based. */
  attempt: number;
}

export interface AlertChannel {
  readonly type: string;
  /** Label for logs/metrics/probe results — never a URL or a key. */
  readonly name: string;
  /** Deliver once; throw ({@link AlertDeliveryError} preferably) on failure. */
  send(event: AlertEvent, attempt: DeliveryAttempt): Promise<void>;
  /** Release pooled resources (SMTP connections). */
  close?(): void;
}

export interface HttpDeps {
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

/**
 * One JSON POST with a bounded timeout and no redirects (a redirect could steer a
 * signed body or a bearer-carrying webhook URL elsewhere). Status → retryability per
 * the dispatcher's contract.
 */
export async function postJson(
  deps: HttpDeps,
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs);
  timer.unref?.();
  let res: Response;
  try {
    res = await deps.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      signal: ctrl.signal,
      redirect: 'error',
    });
  } catch (err) {
    const e = err as { name?: string; code?: string; message?: string };
    const why =
      e?.name === 'AbortError'
        ? `timeout after ${deps.timeoutMs} ms`
        : (e?.code ?? e?.name ?? 'network error');
    throw new AlertDeliveryError(`request failed: ${why}`, true);
  } finally {
    clearTimeout(timer);
  }
  if (res.ok) return;
  const retryable = res.status === 429 || res.status >= 500;
  throw new AlertDeliveryError(`sink returned HTTP ${res.status}`, retryable, res.status);
}
