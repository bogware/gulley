import type { NormalizedUsage } from '@gulley/cost';
import type { Readable } from 'node:stream';
import type { SSEEvent } from './sse';

export interface UpstreamCredential {
  /** How the credential is attached upstream: Anthropic uses `x-api-key`;
   *  OpenAI/Bedrock use `Authorization: Bearer`; Azure uses the `api-key` header
   *  (or `bearer` for Entra ID tokens). */
  scheme: 'x-api-key' | 'bearer' | 'api-key';
  value: string;
}

export interface ForwardRequest {
  /** Upstream path to forward to, e.g. `/v1/messages`, `/v1/chat/completions`. */
  path: string;
  /** Raw request body bytes, already read from the client. */
  body: Buffer;
  /** Client headers; the adapter forwards the safe ones and strips auth. */
  headers: Record<string, string | string[] | undefined>;
  credential: UpstreamCredential;
  signal: AbortSignal;
  /** Time-to-response-headers budget for this forward (ms). Streaming responses
   *  answer in seconds, but a NON-streamed long generation can legitimately take
   *  minutes before its first byte; the gateway threads UPSTREAM_HEADERS_TIMEOUT_MS
   *  here. Adapters default to 60 s when absent. */
  headersTimeoutMs?: number;
}

export interface ForwardResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Readable;
}

/** A provider adapter issues the upstream call and hands back its raw response. */
export interface ProviderAdapter {
  readonly name: string;
  /** True for an adapter whose response is ALWAYS an SSE stream regardless of the
   *  client's `stream` flag (the cross-family translators force `stream:true`
   *  upstream). The pipeline then meters + frames the response as streamed even for
   *  a `stream:false` client, instead of trying to JSON-parse SSE ($0 metered). */
  readonly alwaysStream?: boolean;
  forward(req: ForwardRequest): Promise<ForwardResponse>;
}

/**
 * The request itself is unserviceable by this adapter (an untranslatable field, an
 * unsafe model id) — a CLIENT error, not an upstream fault. The pipeline answers 400
 * without a breaker fault, a same-target retry or a failover: a bare `throw` used to
 * be counted as a connection error, so five such requests opened the provider's
 * circuit fleet-wide and each one replayed up to RETRY_MAX_ATTEMPTS times.
 */
export class ProviderRequestError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ProviderRequestError';
  }
}

/** Accumulates a provider's usage into the normalized, provider-agnostic shape. */
export interface UsageExtractor {
  ingestSse(events: SSEEvent[]): void;
  ingestJson(json: Record<string, unknown>): void;
  normalized(): NormalizedUsage;
}
