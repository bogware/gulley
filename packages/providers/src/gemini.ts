import { randomUUID } from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import { SSEParser } from './sse';
import {
  type ForwardRequest,
  type ForwardResponse,
  type ProviderAdapter,
  ProviderRequestError,
} from './types';

/**
 * Native Google Gemini / Vertex AI `generateContent` translation.
 *
 * Unlike the OpenAI-compatible preset (which rides Gemini's `/chat/completions`
 * shim), this speaks Gemini's real `contents`/`parts` protocol, so it can
 * round-trip the provider-affine artifacts the shim drops — most importantly the
 * **`thoughtSignature`** on reasoning parts (Gemini's equivalent of Anthropic's
 * extended-thinking signature), which a client must echo back for the model to
 * continue a thinking turn. Text, thinking, **tool-calls** (functionCall /
 * functionResponse / functionDeclarations), and **base64 images** (inlineData)
 * all survive the translation; only genuinely untranslatable content (e.g. a
 * URL-sourced image, which Gemini's inlineData can't carry) is refused (see
 * {@link canTranslateAnthropicToGemini}).
 */

// --- Request: canonical Anthropic Messages -> Gemini generateContent ---

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  inlineData?: { mimeType: string; data: string };
}

function textOf(block: Record<string, unknown>): string {
  return block['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : '';
}

/** A base64 image block is translatable; a URL-sourced image is not (Gemini
 *  inlineData is base64-only). */
function isBase64Image(block: Record<string, unknown>): boolean {
  const source = block['source'] as Record<string, unknown> | undefined;
  return block['type'] === 'image' && source?.['type'] === 'base64';
}

/** Text, thinking, tool_use, tool_result, and base64 images survive; a URL image
 *  (or any other provider-affine block) is refused. */
export function canTranslateAnthropicToGemini(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body['messages']) ? (body['messages'] as unknown[]) : [];
  for (const m of messages) {
    const content = (m as Record<string, unknown>)['content'];
    if (typeof content === 'string') continue;
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as Record<string, unknown>;
        const t = b['type'];
        const ok =
          t === 'text' || t === 'thinking' || t === 'tool_use' || t === 'tool_result'
            ? true
            : t === 'image'
              ? isBase64Image(b)
              : false;
        if (!ok) return false;
      }
    }
  }
  return true;
}

/** Coerce an Anthropic tool_result `content` (string | block[]) into the JSON
 *  object Gemini's functionResponse.response requires. */
function toolResultResponse(content: unknown, isError = false): Record<string, unknown> {
  const wrap = (r: Record<string, unknown>): Record<string, unknown> =>
    isError ? { ...r, error: true } : r;
  if (typeof content === 'string') return wrap({ result: content });
  if (Array.isArray(content)) {
    const text = content
      .map((b) => textOf(b as Record<string, unknown>))
      .filter(Boolean)
      .join('\n');
    return wrap({ result: text });
  }
  if (content && typeof content === 'object') return wrap(content as Record<string, unknown>);
  return wrap({ result: content ?? null });
}

function partsForContent(content: unknown, toolNameById: Map<string, string>): GeminiPart[] {
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
    } else if (block['type'] === 'tool_use') {
      const name = typeof block['name'] === 'string' ? block['name'] : '';
      const args =
        block['input'] && typeof block['input'] === 'object'
          ? (block['input'] as Record<string, unknown>)
          : {};
      const part: GeminiPart = { functionCall: { name, args } };
      // Echo the thought signature Gemini attached to this call (relayed to the
      // client as a signature_delta on the tool_use block) — mandatory on newer
      // Gemini models for the function-calling contract.
      if (typeof block['signature'] === 'string') part.thoughtSignature = block['signature'];
      parts.push(part);
    } else if (block['type'] === 'tool_result') {
      // Gemini keys functionResponse on the function NAME, but the Anthropic block
      // carries only tool_use_id — resolve it from the prior tool_use blocks.
      const id = typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : '';
      const name = toolNameById.get(id) ?? id;
      parts.push({
        functionResponse: {
          name,
          response: toolResultResponse(block['content'], block['is_error'] === true),
        },
      });
    } else if (isBase64Image(block)) {
      const source = block['source'] as Record<string, unknown>;
      parts.push({
        inlineData: {
          mimeType: typeof source['media_type'] === 'string' ? source['media_type'] : '',
          data: typeof source['data'] === 'string' ? source['data'] : '',
        },
      });
    }
  }
  return parts;
}

/** Scan every assistant `tool_use` block to build the tool_use_id -> name map a
 *  later `tool_result` needs (Gemini functionResponse keys on name, not id). */
function toolNameIndex(messages: unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    const content = (m as Record<string, unknown>)['content'];
    if (!Array.isArray(content)) continue;
    for (const raw of content) {
      const block = raw as Record<string, unknown>;
      if (block['type'] === 'tool_use' && typeof block['id'] === 'string') {
        map.set(block['id'], typeof block['name'] === 'string' ? block['name'] : block['id']);
      }
    }
  }
  return map;
}

/** Map Anthropic top-level `tools` to Gemini functionDeclarations. */
function toolDeclarations(tools: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const decls = tools
    .map((t) => {
      const tool = t as Record<string, unknown>;
      if (typeof tool['name'] !== 'string') return undefined;
      const decl: Record<string, unknown> = { name: tool['name'] };
      if (typeof tool['description'] === 'string') decl['description'] = tool['description'];
      if (tool['input_schema'] && typeof tool['input_schema'] === 'object')
        decl['parameters'] = tool['input_schema'];
      return decl;
    })
    .filter((d): d is Record<string, unknown> => d !== undefined);
  return decls.length > 0 ? { functionDeclarations: decls } : undefined;
}

/** Map Anthropic `tool_choice` to Gemini toolConfig.functionCallingConfig. */
function toolConfig(choice: unknown): Record<string, unknown> | undefined {
  // Anthropic uses an object ({type:'auto'|'any'|'tool'|'none', name?}); tolerate a
  // bare string form too.
  const type = typeof choice === 'string' ? choice : (choice as Record<string, unknown>)?.['type'];
  if (type === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
  if (type === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (type === 'any') return { functionCallingConfig: { mode: 'ANY' } };
  if (type === 'tool') {
    const name = (choice as Record<string, unknown>)['name'];
    return {
      functionCallingConfig: {
        mode: 'ANY',
        ...(typeof name === 'string' ? { allowedFunctionNames: [name] } : {}),
      },
    };
  }
  return undefined;
}

export function anthropicToGemini(body: Record<string, unknown>): Record<string, unknown> {
  const contents: Array<{ role: string; parts: GeminiPart[] }> = [];
  const inMsgs = Array.isArray(body['messages']) ? (body['messages'] as unknown[]) : [];
  const toolNameById = toolNameIndex(inMsgs);
  for (const m of inMsgs) {
    const msg = m as Record<string, unknown>;
    const parts = partsForContent(msg['content'], toolNameById);
    if (parts.length === 0) continue;
    contents.push({ role: msg['role'] === 'assistant' ? 'model' : 'user', parts });
  }

  const out: Record<string, unknown> = { contents };

  const tools = toolDeclarations(body['tools']);
  if (tools) out['tools'] = [tools];
  const tc = toolConfig(body['tool_choice']);
  if (tc) out['toolConfig'] = tc;

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
  if (typeof body['top_k'] === 'number') gen['topK'] = body['top_k'];
  const stop = body['stop_sequences'];
  if (Array.isArray(stop) && stop.length > 0) gen['stopSequences'] = stop;
  // Anthropic `thinking: {type:'enabled', budget_tokens}` → Gemini thinkingConfig, so
  // a client that asked for reasoning actually gets thought parts back (previously
  // the field vanished and no thinking block could ever arrive).
  const thinking = body['thinking'] as Record<string, unknown> | undefined;
  if (thinking && typeof thinking === 'object' && thinking['type'] === 'enabled') {
    const cfg: Record<string, unknown> = { includeThoughts: true };
    if (typeof thinking['budget_tokens'] === 'number')
      cfg['thinkingBudget'] = thinking['budget_tokens'];
    gen['thinkingConfig'] = cfg;
  }
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
  // A fresh id per response — a deterministic per-model id gave every Gemini
  // response the same message.id, defeating client-side correlation.
  const msgId = `msg_gulley_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  let messageStarted = false;
  let sawError = false;
  let open: { type: 'thinking' | 'text'; index: number } | null = null;
  let nextIndex = 0;
  let toolCallSeq = 0;
  let sawToolUse = false;
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

  // Gemini delivers a whole functionCall (full args) in one part — no cross-chunk
  // accumulation. Emit the canonical Anthropic tool_use triple atomically, closing
  // any open text/thinking block first, and never leaving the block "open".
  const emitToolUse = (name: string, args: Record<string, unknown>, sig?: string): void => {
    closeBlock();
    ensureStart();
    const index = nextIndex++;
    sawToolUse = true;
    const id = `toolu_gulley_${toolCallSeq++}`;
    emit('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id, name, input: {} },
    });
    emit('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(args ?? {}) },
    });
    // Relay the thought signature riding on the functionCall part so the client can
    // echo it back on the next turn (partsForContent re-attaches it).
    if (sig)
      emit('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: sig },
      });
    emit('content_block_stop', { type: 'content_block_stop', index });
  };

  // An in-band Gemini error (`{"error":…}`) or a prompt-level block
  // (`promptFeedback.blockReason`) must surface as an Anthropic `event: error` AND a
  // failed stream — not a clean `end_turn` recorded as a 200 success.
  const fail = (message: string): void => {
    if (sawError) return;
    sawError = true;
    emit('error', { type: 'error', error: { type: 'api_error', message } });
    out.destroy(new Error(`upstream error frame: ${message}`));
  };

  // A model-generated image part -> a canonical Anthropic image content block.
  const emitImage = (mimeType: string, data: string): void => {
    closeBlock();
    ensureStart();
    const index = nextIndex++;
    emit('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'image', source: { type: 'base64', media_type: mimeType, data } },
    });
    emit('content_block_stop', { type: 'content_block_stop', index });
  };

  const handlePart = (part: Record<string, unknown>): void => {
    const fc = part['functionCall'] as { name?: unknown; args?: unknown } | undefined;
    const partSig =
      typeof part['thoughtSignature'] === 'string' ? part['thoughtSignature'] : undefined;
    if (fc && typeof fc.name === 'string') {
      const args =
        fc.args && typeof fc.args === 'object' ? (fc.args as Record<string, unknown>) : {};
      emitToolUse(fc.name, args, partSig);
      return;
    }
    const inline = part['inlineData'] as { mimeType?: unknown; data?: unknown } | undefined;
    if (inline && typeof inline.data === 'string') {
      emitImage(typeof inline.mimeType === 'string' ? inline.mimeType : '', inline.data);
      return;
    }
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
      // A signature on a TEXT part (Gemini attaches it to the last part of a turn):
      // relay it so the client can echo it back on that text block.
      if (sig)
        emit('content_block_delta', {
          type: 'content_block_delta',
          index: open?.index ?? 0,
          delta: { type: 'signature_delta', signature: sig },
        });
    }
  };

  const handle = (chunk: string): void => {
    if (sawError) return;
    for (const ev of parser.push(chunk)) {
      const data = ev.data.trim();
      if (!data || data === '[DONE]') continue;
      let p: Record<string, unknown>;
      try {
        p = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const errObj = p['error'] as Record<string, unknown> | undefined;
      if (errObj && typeof errObj === 'object') {
        fail(typeof errObj['message'] === 'string' ? errObj['message'] : 'upstream error');
        return;
      }
      const feedback = p['promptFeedback'] as Record<string, unknown> | undefined;
      if (feedback && typeof feedback['blockReason'] === 'string') {
        fail(`prompt blocked: ${feedback['blockReason']}`);
        return;
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
    // Propagate backpressure: consumed via 'data' (not .pipe), so a full `out` buffer
    // won't pause the upstream on its own. Without this a slow client lets the
    // PassThrough buffer the entire translated stream in memory (an OOM vector).
    if (out.writableNeedDrain && !upstream.destroyed) {
      upstream.pause();
      out.once('drain', () => {
        if (!upstream.destroyed) upstream.resume();
      });
    }
  });
  upstream.on('end', () => {
    try {
      handle('\n\n');
    } catch {
      /* best-effort */
    }
    if (sawError) return; // already terminated with an error frame
    ensureStart();
    closeBlock();
    emit('message_delta', {
      type: 'message_delta',
      // Gemini reports finishReason=STOP even on a tool turn, so a functionCall
      // part (not the finish reason) is what drives stop_reason='tool_use'.
      delta: { stop_reason: sawToolUse ? 'tool_use' : mapGeminiFinish(finish) },
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

/** Mints a short-lived Bearer token (e.g. a Vertex OAuth2 access token). The mint is
 *  single-flight and self-bounded; it deliberately takes no per-request AbortSignal so
 *  one caller's disconnect can't fail the concurrent callers sharing the exchange. */
export interface TokenProvider {
  getToken(): Promise<string>;
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
  /** The translated upstream call is always streamed (see ProviderAdapter). */
  readonly alwaysStream = true;

  constructor(private readonly opts: GeminiNativeOptions) {}

  async forward(req: ForwardRequest): Promise<ForwardResponse> {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(req.body.toString('utf8') || '{}') as Record<string, unknown>;
    } catch {
      /* leave {} */
    }
    if (!canTranslateAnthropicToGemini(body)) {
      throw new ProviderRequestError(
        'request carries provider-affine content (a URL image or an unknown block) that cannot be translated to Gemini',
      );
    }

    const geminiBody = anthropicToGemini(body);
    const path = (this.opts.pathTemplate ?? DEFAULT_GEMINI_PATH).replace(
      '{model}',
      this.opts.targetModel,
    );
    // Vertex rotates its OAuth access token; mint a fresh Bearer per call when a
    // token provider is wired, otherwise use the route's static credential.
    const credential = this.opts.tokenProvider
      ? { scheme: 'bearer' as const, value: await this.opts.tokenProvider.getToken() }
      : req.credential;
    const resp = await this.opts.inner.forward({
      path,
      body: Buffer.from(JSON.stringify(geminiBody)),
      headers: {},
      credential,
      signal: req.signal,
      headersTimeoutMs: req.headersTimeoutMs,
    });

    if (resp.statusCode >= 400) return resp; // upstream error passes through

    return {
      statusCode: resp.statusCode,
      headers: { 'content-type': 'text/event-stream' },
      body: geminiSseToAnthropic(resp.body, this.opts.targetModel),
    };
  }
}
