import type { Readable } from 'node:stream';
import { getGlobalDispatcher, request } from 'undici';
import type { ForwardRequest, ForwardResponse, ProviderAdapter } from './types';

/** Drain undici's keep-alive connection pool. Call on graceful shutdown (or at
 *  the end of a short-lived script) so the event loop can exit cleanly. */
export async function closeUpstreamPool(): Promise<void> {
  await getGlobalDispatcher().close();
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// Client auth + framing headers we never forward. The gateway attaches the
// upstream credential itself, so the client's virtual key never reaches Anthropic.
const STRIP = new Set(['authorization', 'x-api-key', 'host', 'content-length', 'accept-encoding']);

export interface AnthropicAdapterOptions {
  /** Upstream base URL; overridden in tests to point at a mock. */
  baseUrl?: string;
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = 'anthropic';
  private readonly baseUrl: string;

  constructor(opts: AnthropicAdapterOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  }

  async forward(req: ForwardRequest): Promise<ForwardResponse> {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      const key = k.toLowerCase();
      if (STRIP.has(key) || HOP_BY_HOP.has(key)) continue;
      headers[key] = Array.isArray(v) ? v.join(', ') : v;
    }

    if (req.credential.kind === 'api-key') {
      headers['x-api-key'] = req.credential.value;
    } else {
      headers['authorization'] = `Bearer ${req.credential.value}`;
    }
    headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01';
    headers['content-type'] = headers['content-type'] ?? 'application/json';

    const res = await request(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: req.body,
      signal: req.signal,
      // Long, gappy SSE streams: never time out the body; bound only the headers.
      bodyTimeout: 0,
      headersTimeout: 60_000,
    });

    return {
      statusCode: res.statusCode,
      headers: res.headers,
      body: res.body as unknown as Readable,
    };
  }
}
