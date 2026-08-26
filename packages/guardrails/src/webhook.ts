import { assertEgressAllowed } from '@gulley/egress';
import type { Finding, GuardrailDirection, GuardrailPlugin, GuardrailPluginResult } from './types';

/**
 * A bring-your-own-DLP guardrail: POSTs the text to an operator-configured
 * webhook and maps its verdict onto the plugin seam — zero code to plug in a
 * proprietary moderation/DLP service. Runs on the request (input) direction like
 * the other async plugins. Fail-open by default (availability); fail-closed
 * blocks when the webhook is unreachable. The webhook URL is validated against
 * the SSRF guard unless `allowInternal` is set (for an internal DLP service).
 *
 * Request  body: { "text": string, "direction": "input" | "output" }
 * Response body: { "action": "allow" | "block" | "mask", "maskedText"?: string,
 *                  "categories"?: string[], "reason"?: string }
 */
export interface WebhookGuardrailOptions {
  url: string;
  /** Extra headers (e.g. an auth token) sent with the webhook call. */
  headers?: Record<string, string>;
  /** Abandon the call after this long. Default 3000ms. */
  timeoutMs?: number;
  /** What to do when the webhook errors/times out. Default 'open' (allow). */
  failMode?: 'open' | 'closed';
  /** Exact hostnames the webhook may resolve to (defense in depth). */
  allowlist?: readonly string[];
  /** Allow an internal/loopback webhook host (operator-run DLP). Default false. */
  allowInternal?: boolean;
  /** Require https for the webhook (default true). */
  requireHttps?: boolean;
  /** Display name (for findings / audit). Default 'webhook'. */
  name?: string;
  fetchImpl?: typeof fetch;
}

interface WebhookVerdict {
  action?: 'allow' | 'block' | 'mask';
  maskedText?: string;
  categories?: string[];
  reason?: string;
}

export class WebhookGuardrailPlugin implements GuardrailPlugin {
  readonly name: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly failMode: 'open' | 'closed';
  private readonly fetchImpl: typeof fetch;

  constructor(opts: WebhookGuardrailOptions) {
    const parsed = new URL(opts.url); // throws on an invalid URL — a config error
    if (parsed.username || parsed.password) {
      throw new Error('credentials in the webhook URL are not allowed');
    }
    if (opts.allowInternal) {
      const allow = opts.allowlist?.map((h) => h.toLowerCase());
      if (allow && allow.length > 0 && !allow.includes(parsed.hostname.toLowerCase())) {
        throw new Error(`webhook host not allowlisted: ${parsed.hostname}`);
      }
    } else {
      assertEgressAllowed(opts.url, {
        allowlist: opts.allowlist,
        requireHttps: opts.requireHttps ?? true,
      });
    }
    this.name = opts.name ?? 'webhook';
    this.url = parsed.toString();
    this.headers = opts.headers ?? {};
    this.timeoutMs = opts.timeoutMs ?? 3000;
    this.failMode = opts.failMode ?? 'open';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async inspect(text: string, direction: GuardrailDirection): Promise<GuardrailPluginResult> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers },
        body: JSON.stringify({ text, direction }),
        signal: ac.signal,
      });
      if (!res.ok) return this.onFailure();
      const verdict = (await res.json()) as WebhookVerdict;
      const action = verdict.action ?? 'allow';
      if (action === 'block') return { action: 'blocked', findings: this.findings(verdict, text) };
      if (action === 'mask' && typeof verdict.maskedText === 'string') {
        return {
          action: 'masked',
          findings: this.findings(verdict, text),
          maskedText: verdict.maskedText,
        };
      }
      return { action: 'none', findings: [] };
    } catch {
      return this.onFailure();
    } finally {
      clearTimeout(timer);
    }
  }

  private onFailure(): GuardrailPluginResult {
    return this.failMode === 'closed'
      ? {
          action: 'blocked',
          findings: [
            { category: 'webhook_error', start: 0, end: 0, source: 'plugin', confidence: 1 },
          ],
        }
      : { action: 'none', findings: [] };
  }

  private findings(verdict: WebhookVerdict, text: string): Finding[] {
    const cats = verdict.categories?.length ? verdict.categories : [this.name];
    return cats.map((category) => ({
      category,
      start: 0,
      end: text.length,
      source: 'plugin' as const,
      confidence: 1,
    }));
  }
}
