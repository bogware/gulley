import { computeCost, emptyUsage, type RateResolver, toMicroUsd } from '@gulley/cost';
import { assertEgressAllowed } from '@gulley/egress';

import type { EvalCase, EvalResult } from './eval-rollout';

/**
 * Runs an eval case against one target model by proxying it through the REAL gateway
 * data plane (so routing, authz, guardrails, residency, and metering all apply exactly
 * as they would for production traffic), then shapes the response into an
 * {@link EvalResult} for the deterministic scorers.
 *
 * A port so the rollout routes are testable with canned results (no live provider).
 */
export interface EvalRunner {
  run(model: string, evalCase: EvalCase): Promise<EvalResult>;
}

export interface GatewayEvalRunnerOptions {
  /** Base URL of the gateway (e.g. https://gulley-gw.internal). */
  gatewayUrl: string;
  /** A virtual key scoped for eval traffic (sent as `x-api-key`). */
  apiKey: string;
  /** Egress allowlist — the gateway host must be on it (SSRF guard, like every
   *  other outbound control-plane call). */
  allowlist?: ReadonlySet<string> | readonly string[];
  /** Optional pricing so the `max-cost-micro-usd` scorer works; without it cost is
   *  reported as null. Built from MODELS_CATALOG_FILE the same way the gateway does. */
  rateResolver?: RateResolver;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Default max_tokens when a case omits it. */
  defaultMaxTokens?: number;
}

interface AnthropicResponse {
  stop_reason?: string | null;
  content?: Array<{ type?: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

function extractText(body: AnthropicResponse): string {
  return (body.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

function costFrom(
  model: string,
  usage: AnthropicResponse['usage'],
  resolver: RateResolver | undefined,
): number | null {
  if (!usage) return null;
  const u = {
    ...emptyUsage(),
    inputTokens: usage.input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: usage.cache_creation_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  };
  const cost = computeCost('anthropic', model, u, resolver);
  return cost.priced ? toMicroUsd(cost.totalUsd) : null;
}

/** Gateway-backed runner. Sends a non-streamed Anthropic Messages request so the
 *  response is a single JSON body to score. */
export class GatewayEvalRunner implements EvalRunner {
  constructor(private readonly opts: GatewayEvalRunnerOptions) {}

  async run(model: string, evalCase: EvalCase): Promise<EvalResult> {
    const url = `${this.opts.gatewayUrl.replace(/\/$/, '')}/v1/messages`;
    // SSRF guard before the outbound call — the gateway host must be allowlisted.
    assertEgressAllowed(url, { allowlist: this.opts.allowlist });

    const payload = {
      model,
      max_tokens: evalCase.request.max_tokens ?? this.opts.defaultMaxTokens ?? 1024,
      ...(evalCase.request.system ? { system: evalCase.request.system } : {}),
      messages: evalCase.request.messages,
      stream: false,
    };

    const doFetch = this.opts.fetchImpl ?? fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 60_000);
    timer.unref?.();
    const started = Date.now();
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.opts.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        return {
          outputText: '',
          stopReason: null,
          inputTokens: null,
          outputTokens: null,
          costMicroUsd: null,
          latencyMs,
          guardrailFlagged: res.headers.get('x-gulley-guardrail') !== null,
          error: `gateway returned ${res.status}`,
        };
      }
      const body = (await res.json()) as AnthropicResponse;
      const guardrail = res.headers.get('x-gulley-guardrail');
      return {
        outputText: extractText(body),
        stopReason: body.stop_reason ?? null,
        inputTokens: body.usage?.input_tokens ?? null,
        outputTokens: body.usage?.output_tokens ?? null,
        costMicroUsd: costFrom(model, body.usage, this.opts.rateResolver),
        latencyMs,
        // 'audit' means the output was scanned but not altered (clean); any other
        // value (mask/redact/output-blocked/stream-enforce) means the guardrail acted.
        guardrailFlagged: guardrail !== null && guardrail !== 'audit',
      };
    } catch (err) {
      return {
        outputText: '',
        stopReason: null,
        inputTokens: null,
        outputTokens: null,
        costMicroUsd: null,
        latencyMs: Date.now() - started,
        guardrailFlagged: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
