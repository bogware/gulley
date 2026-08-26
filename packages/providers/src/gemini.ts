import { PassThrough, type Readable } from 'node:stream';
import { SSEParser } from './sse';
import type { ForwardRequest, ForwardResponse, ProviderAdapter } from './types';

/**
 * Native Google Gemini / Vertex AI `generateContent` translation.
 *
 * Unlike the OpenAI-compatible preset (which rides Gemini's `/chat/completions`
 * shim), this speaks Gemini's real `contents`/`parts` protocol, so it can
 * round-trip the provider-affine artifacts the shim drops — most importantly the
 * **`thoughtSignature`** on reasoning parts (Gemini's equivalent of Anthropic's
 * extended-thinking signature), which a client must echo back for the model to
 * continue a thinking turn. Text + thinking survive the translation; tool/image
 * blocks are pinned to their origin family and refused (see
 * {@link canTranslateAnthropicToGemini}).
 */

// --- Request: canonical Anthropic Messages -> Gemini generateContent ---

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
}

function textOf(block: Record<string, unknown>): string {
  return block['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : '';
}

/** Only text + thinking blocks survive; tool_use/tool_result/image are refused. */
export function canTranslateAnthropicToGemini(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body['messages']) ? (body['messages'] as unknown[]) : [];
  for (const m of messages) {
    const content = (m as Record<string, unknown>)['content'];
    if (typeof content === 'string') continue;
    if (Array.isArray(content)) {
      for (const block of content) {
        const t = (block as Record<string, unknown>)['type'];
        if (t !== 'text' && t !== 'thinking') return false;
      }
    }
  }
  return true;
}

function partsForContent(content: unknown): GeminiPart[] {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: GeminiPart[] = [];
  for (const raw of content) {
    const block = raw as Record<string, unknown>;
    if (block['type'] === 'text') {
      const text = textOf(block);
      if (text) parts.push({ text });
    } else if (block['type'] === 'thinking') {
      // Round-trip a prior thinking turn back to Gemini: carry the signature so
      // the model accepts the reasoning as its own.
      const part: GeminiPart = { thought: true };
      if (typeof block['thinking'] === 'string') part.text = block['thinking'];
      if (typeof block['signature'] === 'string') part.thoughtSignature = block['signature'];
      parts.push(part);
    }
  }
  return parts;
}

export function anthropicToGemini(body: Record<string, unknown>): Record<string, unknown> {
  const contents: Array<{ role: string; parts: GeminiPart[] }> = [];
  const inMsgs = Array.isArray(body['messages']) ? (body['messages'] as unknown[]) : [];
  for (const m of inMsgs) {
    const msg = m as Record<string, unknown>;
    const parts = partsForContent(msg['content']);
    if (parts.length === 0) continue;
    contents.push({ role: msg['role'] === 'assistant' ? 'model' : 'user', parts });
  }

  const out: Record<string, unknown> = { contents };

  const system = body['system'];
  let sysText = '';
  if (typeof system === 'string') sysText = system;
  else if (Array.isArray(system))
    sysText = system
      .map((b) => textOf(b as Record<string, unknown>))
      .filter(Boolean)
      .join('\n');
  if (sysText) out['systemInstruction'] = { parts: [{ text: sysText }] };

  const gen: Record<string, unknown> = {};
  if (typeof body['max_tokens'] === 'number') gen['maxOutputTokens'] = body['max_tokens'];
  if (typeof body['temperature'] === 'number') gen['temperature'] = body['temperature'];
  if (typeof body['top_p'] === 'number') gen['topP'] = body['top_p'];
  const stop = body['stop_sequences'];
  if (Array.isArray(stop) && stop.length > 0) gen['stopSequences'] = stop;
  if (Object.keys(gen).length > 0) out['generationConfig'] = gen;

  return out;
}

// --- Response: Gemini streamGenerateContent SSE -> canonical Anthropic SSE ---

function mapGeminiFinish(reason: unknown): string {
  switch (reason) {
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
      return 'refusal';
    case 'STOP':
    default:
      return 'end_turn';
  }
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : fallback;
}

/**
 * Translate a Gemini `streamGenerateContent?alt=sse` stream into Anthropic
 * Messages SSE. Thinking parts (`thought: true`) become a `thinking` content
 * block; a part's `thoughtSignature` is relayed as a `signature_delta` so the
 * reasoning signature survives to the client. Usage lands in the final
 * `message_delta.usage` (Gemini reports it per-chunk; we take the last).
 */
export function geminiSseToAnthropic(upstream: Readable, model: string): Readable {
  const out = new PassThrough();
  const parser = new SSEParser();
  const msgId = `msg_gulley_${model.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}`;

  let messageStarted = false;
  let open: { type: 'thinking' | 'text'; index: number } | null = null;
  let nextIndex = 0;
  let finish: unknown = 'STOP';
  let promptTokens = 0;
  let candidateTokens = 0;
  let thoughtsTokens = 0;
  let cachedTokens = 0;

  const emit = (event: string, data: object): void => {
    out.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const ensureStart = (): void => {
    if (messageStarted) return;
    messageStarted = true;
    emit('message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };

  const closeBlock = (): void => {
    if (!open) return;
    emit('content_block_stop', { type: 'content_block_stop', index: open.index });
    open = null;
  };

  const openBlock = (type: 'thinking' | 'text'): void => {
    if (open && open.type === type) return;
    closeBlock();
    ensureStart();
    const index = nextIndex++;
    open = { type, index };
    emit('content_block_start', {
      type: 'content_block_start',
      index,
      content_block:
        type === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' },
    });
  };

  const handlePart = (part: Record<string, unknown>): void => {
    const text = typeof part['text'] === 'string' ? part['text'] : '';
    const sig = typeof part['thoughtSignature'] === 'string' ? part['thoughtSignature'] : undefined;
    if (part['thought'] === true || (sig && !text)) {
      openBlock('thinking');
      if (text)
        emit('content_block_delta', {
          type: 'content_block_delta',
          index: open?.index ?? 0,
          delta: { type: 'thinking_delta', thinking: text },
        });
      if (sig)
        emit('content_block_delta', {
          type: 'content_block_delta',
          index: open?.index ?? 0,
          delta: { type: 'signature_delta', signature: sig },
        });
      return;
    }
    if (text) {
      openBlock('text');
      emit('content_block_delta', {
        type: 'content_block_delta',
        index: open?.index ?? 0,
        delta: { type: 'text_delta', text },
      });
    }
  };

  const handle = (chunk: string): void => {
    for (const ev of parser.push(chunk)) {
      const data = ev.data.trim();
      if (!data || data === '[DONE]') continue;
      let p: Record<string, unknown>;
      try {
        p = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const usage = p['usageMetadata'] as Record<string, unknown> | undefined;
      if (usage) {
        promptTokens = num(usage['promptTokenCount'], promptTokens);
        candidateTokens = num(usage['candidatesTokenCount'], candidateTokens);
        thoughtsTokens = num(usage['thoughtsTokenCount'], thoughtsTokens);
        cachedTokens = num(usage['cachedContentTokenCount'], cachedTokens);
      }
      const candidates = p['candidates'] as Array<Record<string, unknown>> | undefined;
      const cand = candidates?.[0];
      if (!cand) continue;
      const content = cand['content'] as Record<string, unknown> | undefined;
      const parts = content?.['parts'] as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(parts)) for (const part of parts) handlePart(part);
      if (typeof cand['finishReason'] === 'string') finish = cand['finishReason'];
    }
  };

  upstream.on('data', (chunk: Buffer) => {
    try {
      handle(chunk.toString('utf8'));
    } catch {
      /* best-effort */
    }
  });
  upstream.on('end', () => {
    try {
      handle('\n\n');
    } catch {
      /* best-effort */
    }
    ensureStart();
    closeBlock();
    emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: mapGeminiFinish(finish) },
      usage: {
        input_tokens: Math.max(0, promptTokens - cachedTokens),
        cache_read_input_tokens: cachedTokens,
        // Anthropic output includes thinking tokens; Gemini bills them separately.
        output_tokens: candidateTokens + thoughtsTokens,
      },
    });
    emit('message_stop', { type: 'message_stop' });
    out.end();
  });
  upstream.on('error', (err: Error) => out.destroy(err));

  return out;
}

// --- Adapter: Anthropic in, native Gemini upstream, Anthropic out ---

/** Mints a short-lived Bearer token (e.g. a Vertex OAuth2 access token). */
export interface TokenProvider {
  getToken(signal?: AbortSignal): Promise<string>;
}

export interface GeminiNativeOptions {
  /** Underlying passthrough adapter that does the HTTP to the Gemini/Vertex host. */
  inner: ProviderAdapter;
  /** Gemini/Vertex model id to serve, injected into the upstream path. */
  targetModel: string;
  /** Path template; `{model}` is replaced with targetModel. Default = Gemini API.
   *  For Vertex, pass e.g.
   *  `/v1/projects/P/locations/L/publishers/google/models/{model}:streamGenerateContent?alt=sse`. */
  pathTemplate?: string;
  /** When set, the adapter mints its OWN Bearer credential per call (auto-rotating
   *  Vertex OAuth tokens), ignoring the route credential. */
  tokenProvider?: TokenProvider;
}

const DEFAULT_GEMINI_PATH = '/v1beta/models/{model}:streamGenerateContent?alt=sse';

export class GeminiNativeAdapter implements ProviderAdapter {
  readonly name = 'anthropic->gemini';

  constructor(private readonly opts: GeminiNativeOptions) {}

  async forward(req: ForwardRequest): Promise<ForwardResponse> {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(req.body.toString('utf8') || '{}') as Record<string, unknown>;
    } catch {
      /* leave {} */
    }
    if (!canTranslateAnthropicToGemini(body)) {
      throw new Error('request has provider-affine content; refusing cross-family translation');
    }

    const geminiBody = anthropicToGemini(body);
    const path = (this.opts.pathTemplate ?? DEFAULT_GEMINI_PATH).replace(
      '{model}',
      this.opts.targetModel,
    );
    // Vertex rotates its OAuth access token; mint a fresh Bearer per call when a
    // token provider is wired, otherwise use the route's static credential.
    const credential = this.opts.tokenProvider
      ? { scheme: 'bearer' as const, value: await this.opts.tokenProvider.getToken(req.signal) }
      : req.credential;
    const resp = await this.opts.inner.forward({
      path,
      body: Buffer.from(JSON.stringify(geminiBody)),
      headers: {},
      credential,
      signal: req.signal,
    });

    if (resp.statusCode >= 400) return resp; // upstream error passes through

    return {
      statusCode: resp.statusCode,
      headers: { 'content-type': 'text/event-stream' },
      body: geminiSseToAnthropic(resp.body, this.opts.targetModel),
    };
  }
}
