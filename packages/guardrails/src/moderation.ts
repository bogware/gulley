import type { Finding, GuardrailDirection, GuardrailPlugin, GuardrailPluginResult } from './types';

/**
 * OpenAI Moderation guardrail: classifies the text and blocks when the model
 * flags it. Maps the flagged categories onto findings; never masks (moderation
 * doesn't rewrite). Fail-open by default. Works against any OpenAI-compatible
 * `/v1/moderations` endpoint.
 */
export interface ModerationGuardrailOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  failClosed?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** An undici Dispatcher that pins DNS at connect time (@gulley/egress pinnedEgressAgent). */
  dispatcher?: unknown;
}

interface ModerationResponse {
  results?: Array<{ flagged?: boolean; categories?: Record<string, boolean> }>;
}

export class OpenAIModerationPlugin implements GuardrailPlugin {
  readonly name = 'openai-moderation';
  private readonly url: string;
  private readonly model: string;
  private readonly failClosed: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ModerationGuardrailOptions) {
    this.url = `${(opts.baseUrl ?? 'https://api.openai.com').replace(/\/$/, '')}/v1/moderations`;
    this.model = opts.model ?? 'omni-moderation-latest';
    this.failClosed = opts.failClosed ?? false;
    this.timeoutMs = opts.timeoutMs ?? 3000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async inspect(text: string, _direction: GuardrailDirection): Promise<GuardrailPluginResult> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: text }),
        signal: ac.signal,
        redirect: 'error',
        ...(this.opts.dispatcher ? ({ dispatcher: this.opts.dispatcher } as object) : {}),
      });
      if (!res.ok) return this.onFailure();
      const body = (await res.json()) as ModerationResponse;
      const result = body.results?.[0];
      if (!result?.flagged) return { action: 'none', findings: [] };
      const cats = Object.entries(result.categories ?? {})
        .filter(([, v]) => v)
        .map(([c]) => c);
      return {
        action: 'blocked',
        findings: findingsFor(cats.length ? cats : ['flagged'], text, this.name),
      };
    } catch {
      return this.onFailure();
    } finally {
      clearTimeout(timer);
    }
  }

  private onFailure(): GuardrailPluginResult {
    return this.failClosed
      ? {
          action: 'blocked',
          findings: findingsFor(['moderation_error'], '', this.name),
          degraded: true,
        }
      : { action: 'none', findings: [], degraded: true };
  }
}

export function findingsFor(categories: string[], text: string, _source: string): Finding[] {
  return categories.map((category) => ({
    category,
    start: 0,
    end: text.length,
    source: 'plugin' as const,
    confidence: 1,
  }));
}
