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
}

export interface ForwardResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Readable;
}

/** A provider adapter issues the upstream call and hands back its raw response. */
export interface ProviderAdapter {
  readonly name: string;
  forward(req: ForwardRequest): Promise<ForwardResponse>;
}

/** Accumulates a provider's usage into the normalized, provider-agnostic shape. */
export interface UsageExtractor {
  ingestSse(events: SSEEvent[]): void;
  ingestJson(json: Record<string, unknown>): void;
  normalized(): NormalizedUsage;
}
