import type { EmbeddingProvider } from './types';

export interface OpenAIEmbeddingOptions {
  apiKey: string;
  /** Default `text-embedding-3-small`. */
  model?: string;
  /** Output dimensionality (v3 models support truncation). Default 256 — small,
   *  cheap to index, still strong for cache similarity. */
  dimensions?: number;
  baseUrl?: string;
}

/** Embeddings via the OpenAI (or OpenAI-compatible) `/v1/embeddings` endpoint.
 *  Uses global fetch — no undici pool needed for a single JSON round-trip. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: OpenAIEmbeddingOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'text-embedding-3-small';
    this.dimensions = opts.dimensions ?? 256;
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com').replace(/\/$/, '');
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text, dimensions: this.dimensions }),
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
