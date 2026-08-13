import { PassThrough, type Readable } from 'node:stream';
import { SSEParser } from './sse';
import type { ForwardRequest, ForwardResponse, ProviderAdapter } from './types';

// --- Request: canonical Anthropic Messages -> OpenAI Chat Completions ---

function blockText(block: unknown): string {
  if (block && typeof block === 'object') {
    const b = block as Record<string, unknown>;
    if (b['type'] === 'text' && typeof b['text'] === 'string') return b['text'];
  }
  return '';
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(blockText).join('');
  return '';
}

/**
 * Provider-affine preflight: only text content survives a cross-family
 * translation. tool_use / tool_result / image / thinking blocks are pinned to
 * their origin provider — a route must NOT translate them to OpenAI (they'd be
 * lost). Returns false when the request carries any such block.
 */
export function canTranslateAnthropicToOpenAI(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body['messages']) ? (body['messages'] as unknown[]) : [];
  for (const m of messages) {
    const content = (m as Record<string, unknown>)['content'];
    if (typeof content === 'string') continue;
    if (Array.isArray(content)) {
      for (const block of content) {
        if ((block as Record<string, unknown>)['type'] !== 'text') return false;
      }
    }
  }
  return true;
}

export function anthropicMessagesToOpenAIChat(
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = [];

  const system = body['system'];
  if (typeof system === 'string' && system) {
    messages.push({ role: 'system', content: system });
  } else if (Array.isArray(system)) {
    const text = system.map(blockText).filter(Boolean).join('\n');
    if (text) messages.push({ role: 'system', content: text });
  }

  const inMsgs = Array.isArray(body['messages']) ? (body['messages'] as unknown[]) : [];
  for (const m of inMsgs) {
    const msg = m as Record<string, unknown>;
    messages.push({
      role: msg['role'] === 'assistant' ? 'assistant' : 'user',
      content: contentToText(msg['content']),
    });
  }

  const out: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (typeof body['max_tokens'] === 'number') out['max_tokens'] = body['max_tokens'];
  if (typeof body['temperature'] === 'number') out['temperature'] = body['temperature'];
  const stop = body['stop_sequences'];
  if (Array.isArray(stop) && stop.length > 0) out['stop'] = stop;
  return out;
}

// --- Response: OpenAI Chat SSE -> canonical Anthropic Messages SSE ---

function mapFinish(finish: string | null): string {
  switch (finish) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

/**
 * Translate an OpenAI Chat Completions SSE stream into an Anthropic Messages SSE
 * stream, so a client that speaks Anthropic gets Anthropic-shaped events even
 * when OpenAI served the request. Note: OpenAI reports usage only at the end, so
 * `message_start.usage.input_tokens` is 0 and the real input lands in the final
 * `message_delta.usage` (which is where the gateway's metering reads it too).
 */
export function openaiChatSseToAnthropic(upstream: Readable, model: string): Readable {
  const out = new PassThrough();
  const parser = new SSEParser();
  let started = false;
  let finish: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  const msgId = `msg_gulley_${Math.random().toString(36).slice(2, 12)}`;

  const emit = (event: string, data: object): void => {
    out.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const ensureStart = (): void => {
    if (started) return;
    started = true;
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
    emit('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
  };

  const handle = (chunk: string): void => {
    for (const ev of parser.push(chunk)) {
      const data = ev.data.trim();
      if (data === '[DONE]') continue;
      let p: Record<string, unknown>;
      try {
        p = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const usage = p['usage'] as Record<string, unknown> | undefined;
      if (usage) {
        promptTokens = num(usage['prompt_tokens'], promptTokens);
        completionTokens = num(usage['completion_tokens'], completionTokens);
        const details = usage['prompt_tokens_details'] as Record<string, unknown> | undefined;
        cachedTokens = num(details?.['cached_tokens'], cachedTokens);
      }
      const choices = p['choices'] as Array<Record<string, unknown>> | undefined;
      const choice = choices?.[0];
      if (choice) {
        const delta = choice['delta'] as Record<string, unknown> | undefined;
        const text = delta?.['content'];
        if (typeof text === 'string' && text.length > 0) {
          ensureStart();
          emit('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          });
        }
        if (typeof choice['finish_reason'] === 'string') finish = choice['finish_reason'];
      }
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
    emit('content_block_stop', { type: 'content_block_stop', index: 0 });
    emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: mapFinish(finish) },
      usage: {
        input_tokens: Math.max(0, promptTokens - cachedTokens),
        cache_read_input_tokens: cachedTokens,
        output_tokens: completionTokens,
      },
    });
    emit('message_stop', { type: 'message_stop' });
    out.end();
  });
  upstream.on('error', (err: Error) => out.destroy(err));

  return out;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' ? v : fallback;
}

// --- Adapter: wraps an OpenAI-family adapter to accept Anthropic + emit Anthropic ---

export interface AnthropicToOpenAIOptions {
  /** Underlying OpenAI/Azure adapter that does the actual HTTP. */
  inner: ProviderAdapter;
  /** OpenAI model/deployment to translate the request to. */
  targetModel: string;
}

export class AnthropicToOpenAIAdapter implements ProviderAdapter {
  readonly name = 'anthropic->openai';

  constructor(private readonly opts: AnthropicToOpenAIOptions) {}

  async forward(req: ForwardRequest): Promise<ForwardResponse> {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(req.body.toString('utf8') || '{}') as Record<string, unknown>;
    } catch {
      /* leave {} */
    }
    if (!canTranslateAnthropicToOpenAI(body)) {
      throw new Error('request has provider-affine content; refusing cross-family translation');
    }

    const openaiBody = anthropicMessagesToOpenAIChat(body, this.opts.targetModel);
    const resp = await this.opts.inner.forward({
      path: req.path,
      body: Buffer.from(JSON.stringify(openaiBody)),
      headers: {},
      credential: req.credential,
      signal: req.signal,
    });

    if (resp.statusCode >= 400) return resp; // upstream error passes through

    return {
      statusCode: resp.statusCode,
      headers: { 'content-type': 'text/event-stream' },
      body: openaiChatSseToAnthropic(resp.body, this.opts.targetModel),
    };
  }
}
