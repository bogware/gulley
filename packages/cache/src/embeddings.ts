import type { EmbeddingProvider } from './types';

export interface OpenAIEmbeddingOptions {
  apiKey: string;
  /** Default `text-embedding-3-small`. */
  model?: string;
  /** Output dimensionality (v3 models support truncation). Default 256 — small,
   *  cheap to index, still strong for cache similarity. */
  dimensions?: number;
  baseUrl?: string;
  /** Request timeout (ms). The cache is best-effort; a slow embeddings endpoint
   *  must not stall the request. Default 4000. */
  timeoutMs?: number;
}

/** Embeddings via the OpenAI (or OpenAI-compatible) `/v1/embeddings` endpoint.
 *  Uses global fetch — no undici pool needed for a single JSON round-trip. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: OpenAIEmbeddingOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'text-embedding-3-small';
    this.dimensions = opts.dimensions ?? 256;
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 4000;
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    // Bound by the internal timeout AND any caller signal (whichever fires first).
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text, dimensions: this.dimensions }),
      signal: abort,
    });
    if (!res.ok) {
      throw new Error(`embeddings request failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const embedding = json.data?.[0]?.embedding;
    if (!embedding) throw new Error('embeddings response missing data[0].embedding');
    return embedding;
  }
}
