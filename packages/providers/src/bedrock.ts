import { assertSafePathSegment } from '@gulley/egress';
import { Readable } from 'node:stream';
import { request } from 'undici';
import { bedrockErrorMessage, shapeBedrockError } from './bedrock-errors';
import { bedrockToSse } from './bedrock-eventstream';
import {
  type ForwardRequest,
  type ForwardResponse,
  type ProviderAdapter,
  ProviderRequestError,
} from './types';

export interface BedrockAdapterOptions {
  region?: string;
  /** Full base URL override (tests point this at a mock). */
  baseUrl?: string;
  /** Synthesize an Anthropic `ping` SSE event after this many ms without an upstream
   *  frame (once the stream has started), so a client idle watchdog — Claude Code's
   *  streaming idle timeout — does not trip during a long pause on a Bedrock stream,
   *  which carries no pings of its own. Default 15 s (Anthropic's own cadence);
   *  0 disables. See {@link BedrockAdapterOptions.pingMaxIdleMs}. */
  pingIntervalMs?: number;
  /** Stop synthesizing pings after this long without a real frame (default 5 min):
   *  past that the gateway's own inactivity watchdog must be allowed to see the hang. */
  pingMaxIdleMs?: number;
  /** `anthropic-beta` values NOT to forward into the body's `anthropic_beta` list
   *  (values this Bedrock region/model rejects). Everything else is forwarded as an
   *  open list, per Anthropic's gateway contract. */
  betaDeny?: readonly string[];
}

/** Bedrock error bodies are small JSON documents; cap the read defensively. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/**
 * Claude-on-Bedrock adapter. The client sends a native Anthropic Messages body
 * (with `model`); this rewrites it for Bedrock (model → URL path, drop
 * `model`/`stream`, add `anthropic_version`, carry the client's `anthropic-beta`
 * header as the `anthropic_beta` body list). A `stream: true` request goes to
 * invoke-with-response-stream and the eventstream reply is decoded back into Anthropic
 * SSE — with `ping` events synthesized during pauses, since Bedrock sends none; any
 * other request goes to `invoke`, whose JSON reply (the Anthropic message object)
 * passes through as-is. HTTP errors are reshaped into Anthropic's error envelope
 * (status kept, message verbatim, `capability_rejected:` tokens where the contract
 * defines them) so client SDKs and Claude Code's recovery paths understand them.
 * `count_tokens` is served by Bedrock's CountTokens API. Auth is a Bedrock API key
 * (bearer). SigV4 and the Converse API are later additions.
 */
export class BedrockAdapter implements ProviderAdapter {
  readonly name = 'bedrock';
  private readonly baseUrl: string;
  private readonly pingIntervalMs: number;
  private readonly pingMaxIdleMs: number | undefined;
  private readonly betaDeny: ReadonlySet<string>;

  constructor(opts: BedrockAdapterOptions = {}) {
    const region = opts.region ?? 'us-east-1';
    this.baseUrl = (opts.baseUrl ?? `https://bedrock-runtime.${region}.amazonaws.com`).replace(
      /\/$/,
      '',
    );
    this.pingIntervalMs = Math.max(0, opts.pingIntervalMs ?? 15_000);
    this.pingMaxIdleMs = opts.pingMaxIdleMs;
    this.betaDeny = new Set((opts.betaDeny ?? []).map((b) => b.trim()).filter(Boolean));
  }

  /** Parse the client body and shape it for Bedrock: `{ model, streaming, rest }`. */
  private shape(req: ForwardRequest): {
    model: string;
    streaming: boolean;
    rest: Record<string, unknown>;
  } {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(req.body.toString('utf8') || '{}') as Record<string, unknown>;
    } catch {
      /* leave {} — model will be empty and Bedrock will 400, forwarded as-is */
    }
    const model = typeof parsed['model'] === 'string' ? parsed['model'] : '';
    const streaming = parsed['stream'] === true;

    const rest: Record<string, unknown> = { ...parsed };
    delete rest['model'];
    delete rest['stream'];
    if (!('anthropic_version' in rest)) rest['anthropic_version'] = 'bedrock-2023-05-31';
    // Anthropic's contract: forward `anthropic-beta` as an OPEN list. Bedrock takes the
    // same values in the body's `anthropic_beta` array; a client that already set the
    // body field wins (it speaks Bedrock's dialect deliberately).
    if (!('anthropic_beta' in rest)) {
      const betas = betaValues(req.headers['anthropic-beta']).filter((b) => !this.betaDeny.has(b));
      if (betas.length > 0) rest['anthropic_beta'] = betas;
    }

    // The model id becomes a URL path segment; validate it before encoding so a
    // hostile id (path traversal / control chars) can't reshape the upstream URL. An
    // application-inference-profile / provisioned-throughput / imported-model ARN
    // legitimately contains `/` (encodeURIComponent neutralises it), so ARNs get
    // their own strict shape check instead of the generic segment rule — the
    // generic rule threw, which the pipeline counted as an UPSTREAM fault (a breaker
    // trip after five such requests) and answered 502.
    if (model) {
      if (model.startsWith('arn:aws:bedrock:')) {
        if (!BEDROCK_MODEL_ARN.test(model)) {
          throw new ProviderRequestError(`invalid Bedrock model ARN: ${JSON.stringify(model)}`);
        }
      } else {
        try {
          assertSafePathSegment(model, 'model');
        } catch (err) {
          throw new ProviderRequestError((err as Error).message);
        }
      }
    }
    return { model, streaming, rest };
  }

  private async post(
    req: ForwardRequest,
    path: string,
    accept: string,
    body: string,
  ): Promise<Awaited<ReturnType<typeof request>>> {
    return request(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${req.credential.value}`,
        'content-type': 'application/json',
        accept,
      },
      body,
      signal: req.signal,
      bodyTimeout: 0,
      headersTimeout: req.headersTimeoutMs ?? 60_000,
    });
  }

  async forward(req: ForwardRequest): Promise<ForwardResponse> {
    const { model, streaming, rest } = this.shape(req);
    const path = `/model/${encodeURIComponent(model)}/${
      streaming ? 'invoke-with-response-stream' : 'invoke'
    }`;
    const res = await this.post(
      req,
      path,
      streaming ? 'application/vnd.amazon.eventstream' : 'application/json',
      JSON.stringify(rest),
    );

    // Error responses are plain JSON in Bedrock's own shape — reshape them into the
    // Anthropic envelope (status kept) so SDKs and Claude Code's recovery understand.
    if (res.statusCode >= 400) return shapeErrorResponse(res);

    // A non-streaming `invoke` reply (the Anthropic message object) passes through.
    if (!streaming) {
      return {
        statusCode: res.statusCode,
        headers: res.headers,
        body: res.body as unknown as Readable,
      };
    }

    // Keep the upstream's correlation headers (x-amzn-requestid, bedrock latency /
    // token counts) — dropping them made a Bedrock-side incident untraceable.
    return {
      statusCode: res.statusCode,
      headers: { ...passthroughHeaders(res.headers), 'content-type': 'text/event-stream' },
      body: bedrockToSse(res.body as unknown as Readable, {
        pingIntervalMs: this.pingIntervalMs,
        ...(this.pingMaxIdleMs !== undefined ? { pingMaxIdleMs: this.pingMaxIdleMs } : {}),
      }),
    };
  }

  /** Anthropic `POST /v1/messages/count_tokens` ⇒ Bedrock `CountTokens`
   *  (`POST /model/{id}/count-tokens` with the InvokeModel body), answered in the
   *  Anthropic shape `{ input_tokens }`. */
  async countTokens(req: ForwardRequest): Promise<ForwardResponse> {
    const { model, rest } = this.shape(req);
    const res = await this.post(
      req,
      `/model/${encodeURIComponent(model)}/count-tokens`,
      'application/json',
      JSON.stringify({ input: { invokeModel: { body: JSON.stringify(rest) } } }),
    );
    if (res.statusCode >= 400) return shapeErrorResponse(res);
    const raw = await readCapped(res.body as unknown as Readable, MAX_ERROR_BODY_BYTES);
    let inputTokens: number | undefined;
    try {
      const j = JSON.parse(raw) as { inputTokens?: unknown };
      if (typeof j.inputTokens === 'number') inputTokens = j.inputTokens;
    } catch {
      /* fall through to the 502 below */
    }
    if (inputTokens === undefined) {
      return jsonResponse(
        502,
        passthroughHeaders(res.headers),
        shapeBedrockError(502, 'InternalServerException', 'malformed CountTokens response'),
      );
    }
    return jsonResponse(200, passthroughHeaders(res.headers), { input_tokens: inputTokens });
  }
}

function betaValues(header: string | string[] | undefined): string[] {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return [];
  const out: string[] = [];
  for (const v of raw.split(',')) {
    const t = v.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function passthroughHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!['content-type', 'content-length', 'transfer-encoding', 'connection'].includes(k))
      out[k] = v;
  }
  return out;
}

function jsonResponse(
  statusCode: number,
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
): ForwardResponse {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  return {
    statusCode,
    headers: {
      ...headers,
      'content-type': 'application/json',
      'content-length': String(buf.length),
    },
    body: Readable.from([buf]),
  };
}

async function shapeErrorResponse(
  res: Awaited<ReturnType<typeof request>>,
): Promise<ForwardResponse> {
  const raw = await readCapped(res.body as unknown as Readable, MAX_ERROR_BODY_BYTES);
  const typeHeader = res.headers['x-amzn-errortype'];
  const bedrockType = Array.isArray(typeHeader) ? typeHeader[0] : typeHeader;
  const shaped = shapeBedrockError(res.statusCode, bedrockType, bedrockErrorMessage(raw));
  return jsonResponse(res.statusCode, passthroughHeaders(res.headers), shaped);
}

async function readCapped(body: Readable, cap: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of body) {
    const buf = c as Buffer;
    if (size + buf.length > cap) {
      chunks.push(buf.subarray(0, cap - size));
      size = cap;
      body.destroy();
      break;
    }
    chunks.push(buf);
    size += buf.length;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** arn:aws:bedrock:<region>:<account>:<resource-type>/<id> — the shapes Bedrock's
 *  modelId path parameter accepts besides a bare model id. */
const BEDROCK_MODEL_ARN =
  /^arn:aws:bedrock:[a-z0-9-]{1,32}:\d{12}:(application-inference-profile|inference-profile|provisioned-model|imported-model|custom-model|prompt-router)\/[A-Za-z0-9._:-]{1,128}$/;
