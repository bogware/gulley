import type { Readable } from 'node:stream';

export interface UpstreamCredential {
  kind: 'api-key' | 'bearer';
  value: string;
}

export interface ForwardRequest {
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
