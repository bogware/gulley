import { findingsFor } from './moderation';
import type { GuardrailDirection, GuardrailPlugin, GuardrailPluginResult } from './types';

/**
 * Azure AI Content Safety guardrail: analyzes the text and blocks when any
 * harm category's severity meets `severityThreshold` (Azure severity is 0–7).
 * Fail-open by default. Never masks.
 */
export interface AzureContentSafetyOptions {
  endpoint: string;
  apiKey: string;
  apiVersion?: string;
  /** Block when a category's severity is ≥ this (0–7). Default 4. */
  severityThreshold?: number;
  failClosed?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface AnalyzeResponse {
  categoriesAnalysis?: Array<{ category?: string; severity?: number }>;
}

export class AzureContentSafetyPlugin implements GuardrailPlugin {
  readonly name = 'azure-content-safety';
  private readonly url: string;
  private readonly threshold: number;
  private readonly failClosed: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: AzureContentSafetyOptions) {
    const version = opts.apiVersion ?? '2024-09-01';
    this.url = `${opts.endpoint.replace(/\/$/, '')}/contentsafety/text:analyze?api-version=${version}`;
    this.threshold = opts.severityThreshold ?? 4;
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
          'Ocp-Apim-Subscription-Key': this.opts.apiKey,
        },
        body: JSON.stringify({ text }),
        signal: ac.signal,
      });
      if (!res.ok) return this.onFailure();
      const body = (await res.json()) as AnalyzeResponse;
      const flagged = (body.categoriesAnalysis ?? []).filter(
        (c) => (c.severity ?? 0) >= this.threshold,
      );
      if (flagged.length === 0) return { action: 'none', findings: [] };
      const cats = flagged.map((c) => `azure:${c.category ?? 'harm'}`);
      return { action: 'blocked', findings: findingsFor(cats, text, this.name) };
    } catch {
      return this.onFailure();
    } finally {
      clearTimeout(timer);
    }
  }

  private onFailure(): GuardrailPluginResult {
    return this.failClosed
      ? { action: 'blocked', findings: findingsFor(['content_safety_error'], '', this.name) }
      : { action: 'none', findings: [] };
  }
}
