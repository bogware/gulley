import type {
  Finding,
  GuardrailDirection,
  GuardrailPlugin,
  GuardrailPluginResult,
} from '@gulley/guardrails';
import { request } from 'undici';

export interface BedrockGuardrailOptions {
  /** The guardrail identifier (id or ARN). */
  guardrailId: string;
  /** Version to apply; `DRAFT` uses the working draft. Default `DRAFT`. */
  guardrailVersion?: string;
  /** Bedrock API key (bearer). */
  apiKey: string;
  region?: string;
  /** Full base URL override (tests point this at a mock). */
  baseUrl?: string;
  /** Interpret an intervention as a hard reject (`block`) or use the guardrail's
   *  anonymized text (`mask`). Default `block`. */
  mode?: 'block' | 'mask';
  /** On transport/HTTP error: allow (fail-open) or reject (fail-closed). Note the
   *  gateway wires this from GUARDRAILS_BEDROCK_FAIL_CLOSED (default CLOSED, like the
   *  other enforcement plugins). */
  failClosed?: boolean;
  signal?: AbortSignal;
  /** Per-call deadline (headers AND body). Default 3 s, like the other plugins — a
   *  stalled ApplyGuardrail body previously pinned the request for undici's 300 s. */
  timeoutMs?: number;
}

interface ApplyGuardrailResponse {
  action?: string;
  outputs?: Array<{ text?: string }>;
  assessments?: unknown[];
}

function pluginFinding(text: string): Finding {
  return {
    category: 'bedrock_guardrail',
    start: 0,
    end: text.length,
    source: 'plugin',
    confidence: 0.9,
  };
}

/**
 * Provider guardrail plugin backed by Amazon Bedrock Guardrails' `ApplyGuardrail`
 * REST API. Runs the request/response text through a managed guardrail policy
 * (topic/word/PII/content filters) and maps the verdict onto the native
 * GuardrailPlugin contract. Auth is a Bedrock API key (bearer); SigV4 later.
 */
export class BedrockGuardrailPlugin implements GuardrailPlugin {
  readonly name = 'bedrock-guardrails';
  private readonly baseUrl: string;
  private readonly version: string;
  private readonly mode: 'block' | 'mask';

  constructor(private readonly opts: BedrockGuardrailOptions) {
    const region = opts.region ?? 'us-east-1';
    this.baseUrl = (opts.baseUrl ?? `https://bedrock-runtime.${region}.amazonaws.com`).replace(
      /\/$/,
      '',
    );
    this.version = opts.guardrailVersion ?? 'DRAFT';
    this.mode = opts.mode ?? 'block';
  }

  async inspect(text: string, direction: GuardrailDirection): Promise<GuardrailPluginResult> {
    const source = direction === 'input' ? 'INPUT' : 'OUTPUT';
    const url = `${this.baseUrl}/guardrail/${encodeURIComponent(this.opts.guardrailId)}/version/${encodeURIComponent(this.version)}/apply`;
    const timeoutMs = this.opts.timeoutMs ?? 3_000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref?.();
    const onOuterAbort = (): void => ac.abort();
    this.opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      const res = await request(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ source, content: [{ text: { text } }] }),
        signal: ac.signal,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        maxRedirections: 0,
      });
      const bodyText = await res.body.text();
      if (res.statusCode >= 400) {
        return this.opts.failClosed
          ? { action: 'blocked', findings: [pluginFinding(text)] }
          : { action: 'none', findings: [] };
      }
      const json = JSON.parse(bodyText) as ApplyGuardrailResponse;
      if (json.action !== 'GUARDRAIL_INTERVENED') return { action: 'none', findings: [] };

      const masked = json.outputs?.[0]?.text;
      const findings = [pluginFinding(text)];
      if (this.mode === 'mask' && typeof masked === 'string') {
        return { action: 'masked', findings, maskedText: masked };
      }
      return { action: 'blocked', findings };
    } catch {
      return this.opts.failClosed
        ? { action: 'blocked', findings: [pluginFinding(text)] }
        : { action: 'none', findings: [] };
    } finally {
      clearTimeout(timer);
      this.opts.signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}
