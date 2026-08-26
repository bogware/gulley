import { findingsFor } from './moderation';
import type { Finding, GuardrailDirection, GuardrailPlugin, GuardrailPluginResult } from './types';

/**
 * Google Cloud **Model Armor** guardrail: sanitizes the prompt (input) or model
 * response (output) against a configured template — prompt-injection/jailbreak
 * detection, responsible-AI filters, malicious-URI and CSAM screening, and
 * Sensitive Data Protection (SDP) inspection/de-identification. A `MATCH_FOUND`
 * blocks; when SDP returns de-identified text, that is surfaced as a mask
 * instead. Fail-open by default.
 *
 * Model Armor is authenticated with a Google OAuth2 access token (Bearer). Pass
 * a static `accessToken` (simple/dev) or a `getAccessToken` provider that mints a
 * fresh one (production — tokens expire hourly).
 */
export interface ModelArmorGuardrailOptions {
  projectId: string;
  location: string;
  template: string;
  accessToken?: string;
  getAccessToken?: () => Promise<string> | string;
  failClosed?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Override the API base (for testing); defaults to the regional endpoint. */
  baseUrl?: string;
}

interface FilterMatch {
  matchState?: string;
}
interface SdpResult {
  sdpFilterResult?: {
    inspectResult?: FilterMatch;
    deidentifyResult?: FilterMatch & { data?: { text?: string } };
  };
}
interface SanitizeResponse {
  sanitizationResult?: {
    filterMatchState?: string;
    filterResults?: Record<string, Record<string, FilterMatch> & SdpResult>;
  };
}

const MATCH = 'MATCH_FOUND';

export class ModelArmorPlugin implements GuardrailPlugin {
  readonly name = 'model-armor';
  private readonly base: string;
  private readonly failClosed: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ModelArmorGuardrailOptions) {
    this.base = (opts.baseUrl ?? `https://modelarmor.${opts.location}.rep.googleapis.com`).replace(
      /\/$/,
      '',
    );
    this.failClosed = opts.failClosed ?? false;
    this.timeoutMs = opts.timeoutMs ?? 3000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async inspect(text: string, direction: GuardrailDirection): Promise<GuardrailPluginResult> {
    const method = direction === 'input' ? 'sanitizeUserPrompt' : 'sanitizeModelResponse';
    const url =
      `${this.base}/v1/projects/${this.opts.projectId}/locations/${this.opts.location}` +
      `/templates/${this.opts.template}:${method}`;
    const payload =
      direction === 'input' ? { userPromptData: { text } } : { modelResponseData: { text } };

    const token = await this.token();
    if (!token) return this.onFailure();

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      if (!res.ok) return this.onFailure();
      return this.interpret((await res.json()) as SanitizeResponse, text);
    } catch {
      return this.onFailure();
    } finally {
      clearTimeout(timer);
    }
  }

  private interpret(body: SanitizeResponse, text: string): GuardrailPluginResult {
    const result = body.sanitizationResult;
    if (!result || result.filterMatchState !== MATCH) return { action: 'none', findings: [] };

    const entries = Object.entries(result.filterResults ?? {});
    const matched = entries.filter(([, v]) => filterMatched(v));
    const findings: Finding[] = findingsFor(
      matched.length ? matched.map(([k]) => `model-armor:${k}`) : ['model-armor:match'],
      text,
      this.name,
    );

    // Mask (via SDP de-identified text) ONLY when SDP is the *sole* matched
    // filter. If any non-SDP filter also matched — prompt-injection/jailbreak,
    // RAI, CSAM, malicious URIs — that is a hard block, and downgrading it to a
    // de-identify mask would forward the still-malicious content. Block wins.
    const nonSdpMatch = matched.some(([k]) => k !== 'sdp');
    const deident = (result.filterResults?.['sdp'] as SdpResult | undefined)?.sdpFilterResult
      ?.deidentifyResult;
    const maskedText = deident?.data?.text;
    if (
      !nonSdpMatch &&
      deident?.matchState === MATCH &&
      typeof maskedText === 'string' &&
      maskedText.length > 0
    ) {
      return { action: 'masked', findings, maskedText };
    }
    return { action: 'blocked', findings };
  }

  private async token(): Promise<string | undefined> {
    if (this.opts.getAccessToken) {
      try {
        return (await this.opts.getAccessToken()) || undefined;
      } catch {
        return undefined;
      }
    }
    return this.opts.accessToken;
  }

  private onFailure(): GuardrailPluginResult {
    return this.failClosed
      ? { action: 'blocked', findings: findingsFor(['model-armor:error'], '', this.name) }
      : { action: 'none', findings: [] };
  }
}

/** True when any nested filter result under a top-level filter entry matched. */
function filterMatched(entry: Record<string, FilterMatch> & SdpResult): boolean {
  for (const v of Object.values(entry)) {
    if (v && typeof v === 'object' && (v as FilterMatch).matchState === MATCH) return true;
    // SDP nests inspect/deidentify results one level deeper.
    if (v && typeof v === 'object') {
      for (const inner of Object.values(v as Record<string, FilterMatch>)) {
        if (inner && typeof inner === 'object' && inner.matchState === MATCH) return true;
      }
    }
  }
  return false;
}
