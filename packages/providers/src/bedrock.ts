import { assertSafePathSegment } from '@gulley/egress';
import type { Readable } from 'node:stream';
import { request } from 'undici';
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
}

/**
 * Claude-on-Bedrock adapter. The client sends a native Anthropic Messages body
 * (with `model`); this rewrites it for Bedrock (model → URL path, drop
 * `model`/`stream`, add `anthropic_version`). A `stream: true` request goes to
 * invoke-with-response-stream and the eventstream reply is decoded back into Anthropic
 * SSE; any other request goes to `invoke`, whose JSON reply (the Anthropic message
 * object) passes through as-is — so a non-streaming SDK call is answered with JSON
 * instead of an SSE body it cannot parse. Auth is a Bedrock API key (bearer). SigV4
 * and the Converse API are later additions.
 */
export class BedrockAdapter implements ProviderAdapter {
  readonly name = 'bedrock';
  private readonly baseUrl: string;

  constructor(opts: BedrockAdapterOptions = {}) {
    const region = opts.region ?? 'us-east-1';
    this.baseUrl = (opts.baseUrl ?? `https://bedrock-runtime.${region}.amazonaws.com`).replace(
      /\/$/,
      '',
    );
  }

  async forward(req: ForwardRequest): Promise<ForwardResponse> {
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
    const path = `/model/${encodeURIComponent(model)}/${
      streaming ? 'invoke-with-response-stream' : 'invoke'
    }`;
    const res = await request(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${req.credential.value}`,
        'content-type': 'application/json',
        accept: streaming ? 'application/vnd.amazon.eventstream' : 'application/json',
      },
      body: JSON.stringify(rest),
      signal: req.signal,
      bodyTimeout: 0,
      headersTimeout: req.headersTimeoutMs ?? 60_000,
    });

    // Error responses are plain JSON, not an eventstream — pass them through; so is a
    // non-streaming `invoke` reply (the Anthropic message object, metered as JSON).
    if (res.statusCode >= 400 || !streaming) {
      return {
        statusCode: res.statusCode,
        headers: res.headers,
        body: res.body as unknown as Readable,
      };
    }

    // Keep the upstream's correlation headers (x-amzn-requestid, bedrock latency /
    // token counts) — dropping them made a Bedrock-side incident untraceable.
    const passthrough: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (!['content-type', 'content-length', 'transfer-encoding', 'connection'].includes(k))
        passthrough[k] = v;
    }
    return {
      statusCode: res.statusCode,
      headers: { ...passthrough, 'content-type': 'text/event-stream' },
      body: bedrockToSse(res.body as unknown as Readable),
    };
  }
}

/** arn:aws:bedrock:<region>:<account>:<resource-type>/<id> — the shapes Bedrock's
 *  modelId path parameter accepts besides a bare model id. */
const BEDROCK_MODEL_ARN =
  /^arn:aws:bedrock:[a-z0-9-]{1,32}:\d{12}:(application-inference-profile|inference-profile|provisioned-model|imported-model|custom-model|prompt-router)\/[A-Za-z0-9._:-]{1,128}$/;
