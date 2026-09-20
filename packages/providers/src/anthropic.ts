import type { Readable } from 'node:stream';
import { getGlobalDispatcher, request } from 'undici';
import type { ForwardRequest, ForwardResponse, ProviderAdapter } from './types';

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
// upstream credential itself, so the client's virtual key never reaches upstream.
// Also stripped: the caller's network identity (an ALB stamps x-forwarded-for with
// the END USER's IP, browsers send cookies), proxy tracing, the gateway's own
// x-gulley-* headers, and OpenAI org/project selectors (a client must not steer
// which org the gateway's key bills).
const STRIP = new Set([
  'authorization',
  'x-api-key',
  'host',
  'content-length',
  'accept-encoding',
  'cookie',
  'set-cookie',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'via',
  'x-amzn-trace-id',
  'x-amz-cf-id',
  'cf-connecting-ip',
  'true-client-ip',
  'openai-organization',
  'openai-project',
  'proxy-connection',
]);
const STRIP_PREFIXES = ['x-gulley-'];

/** Drain undici's keep-alive connection pool. Call on graceful shutdown (or at
 *  the end of a short-lived script) so the event loop can exit cleanly. */
export async function closeUpstreamPool(): Promise<void> {
  await getGlobalDispatcher().close();
}

export interface PassthroughAdapterOptions {
  name: string;
  baseUrl: string;
  /** Provider defaults applied when the client didn't send them (e.g. Anthropic's version). */
  defaultHeaders?: Record<string, string>;
}

/**
 * Generic streaming passthrough. Forwards the client body verbatim to
 * `${baseUrl}${path}`, stripping client auth and injecting the gateway's
 * upstream credential. SSE-safe timeouts (no body timeout; bounded headers).
 */
export class PassthroughAdapter implements ProviderAdapter {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;

  constructor(opts: PassthroughAdapterOptions) {
    this.name = opts.name;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.defaultHeaders = opts.defaultHeaders ?? {};
  }

  async forward(req: ForwardRequest): Promise<ForwardResponse> {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      const key = k.toLowerCase();
      if (STRIP.has(key) || HOP_BY_HOP.has(key)) continue;
      if (STRIP_PREFIXES.some((p) => key.startsWith(p))) continue;
      headers[key] = Array.isArray(v) ? v.join(', ') : v;
    }
    for (const [k, v] of Object.entries(this.defaultHeaders)) {
      if (!(k in headers)) headers[k] = v;
    }
    // An empty credential value = keyless upstream (self-hosted / local models
    // like Ollama, Jan, LM Studio) — attach no auth header at all.
    const cred = req.credential.value;
    if (cred) {
      if (req.credential.scheme === 'x-api-key') {
        headers['x-api-key'] = cred;
      } else if (req.credential.scheme === 'api-key') {
        headers['api-key'] = cred;
      } else {
        headers['authorization'] = `Bearer ${cred}`;
      }
    }
    headers['content-type'] = headers['content-type'] ?? 'application/json';

    const res = await request(`${this.baseUrl}${req.path}`, {
      method: 'POST',
      headers,
      body: req.body,
      signal: req.signal,
      bodyTimeout: 0,
      headersTimeout: req.headersTimeoutMs ?? 60_000,
    });

    return {
      statusCode: res.statusCode,
      headers: res.headers,
      body: res.body as unknown as Readable,
    };
  }
}

export class AnthropicAdapter extends PassthroughAdapter {
  constructor(opts: { baseUrl?: string } = {}) {
    super({
      name: 'anthropic',
      baseUrl: opts.baseUrl ?? 'https://api.anthropic.com',
      defaultHeaders: { 'anthropic-version': '2023-06-01' },
    });
  }
}

export class OpenAIAdapter extends PassthroughAdapter {
  constructor(opts: { baseUrl?: string } = {}) {
    super({ name: 'openai', baseUrl: opts.baseUrl ?? 'https://api.openai.com' });
  }
}

/**
 * Azure AI Foundry / Azure OpenAI. `baseUrl` is the resource endpoint
 * (`https://<res>.openai.azure.com`); routes forward to the OpenAI-compatible
 * `/openai/v1/...` surface with the deployment name as the `model`. Auth is the
 * `api-key` header, or an Entra bearer token (credential scheme decides).
 */
export class AzureAdapter extends PassthroughAdapter {
  constructor(opts: { baseUrl: string }) {
    super({ name: 'azure', baseUrl: opts.baseUrl });
  }
}
