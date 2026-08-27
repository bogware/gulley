import type { Readable } from 'node:stream';
import type {
  ClassifierCompleter,
  ClassifierCompletion,
  ClassifierUsage,
  RouteTarget,
} from '@gulley/routing';

/** A classification reply is a single category label — a tiny generation. */
const CLASSIFIER_MAX_TOKENS = 16;
/** A classifier reply is tiny; cap the buffered response defensively. */
const RESPONSE_CAP = 64 * 1024;

export interface ClassifierTargetEntry {
  target: RouteTarget;
  provider: string;
}

async function drain(body: Readable, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > cap) {
      body.destroy();
      break;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Parse a non-streamed Anthropic Messages response into {text, usage}. Usage is
 *  read from the provider's own `usage` object (never canonical fields). */
function parseAnthropic(raw: Buffer, model: string, provider: string): ClassifierCompletion {
  try {
    const j = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    const content = Array.isArray(j['content']) ? j['content'] : [];
    const text = content
      .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
      .filter((b) => b['type'] === 'text' && typeof b['text'] === 'string')
      .map((b) => b['text'] as string)
      .join('');
    const u = (j['usage'] ?? {}) as Record<string, unknown>;
    const inputTokens = typeof u['input_tokens'] === 'number' ? u['input_tokens'] : 0;
    const outputTokens = typeof u['output_tokens'] === 'number' ? u['output_tokens'] : 0;
    const usage: ClassifierUsage | undefined =
      inputTokens > 0 || outputTokens > 0
        ? { provider, model, inputTokens, outputTokens }
        : undefined;
    return usage ? { text, usage } : { text };
  } catch {
    return { text: '' };
  }
}

/**
 * The `llm-router` classifier completer (M15 E): forwards a small, non-streamed
 * Anthropic-canonical classification request to the policy's classifier target
 * and returns the category text + raw usage (for metering). An unwired model, an
 * upstream error, or an unparseable body yields empty text (the engine abstains).
 * v1 speaks the Anthropic-canonical response shape; other classifier provider
 * families are an additive follow-on.
 */
export class GatewayClassifierCompleter implements ClassifierCompleter {
  constructor(private readonly byModel: ReadonlyMap<string, ClassifierTargetEntry>) {}

  async complete(
    model: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<ClassifierCompletion> {
    const entry = this.byModel.get(model);
    if (!entry) return { text: '' }; // no wired classifier provider → abstain
    const body = Buffer.from(
      JSON.stringify({
        model,
        max_tokens: CLASSIFIER_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
      'utf8',
    );
    const resp = await entry.target.adapter.forward({
      path: entry.target.upstreamPath,
      body,
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      credential: entry.target.credential,
      signal: signal ?? new AbortController().signal,
    });
    const raw = await drain(resp.body, RESPONSE_CAP);
    if (resp.statusCode >= 400) return { text: '' }; // upstream error → abstain, no meter
    return parseAnthropic(raw, model, entry.provider);
  }
}
