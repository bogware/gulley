import { resolveOverlaps } from './detector';
import type {
  Detector,
  Finding,
  GuardrailPlugin,
  GuardrailPluginResult,
  GuardrailPolicies,
  GuardrailPolicy,
} from './types';
import { redactText, TokenVault } from './vault';

export interface FindingSummary {
  total: number;
  categories: Record<string, number>;
  maxConfidence: number;
}

export function summarize(findings: Finding[]): FindingSummary {
  const categories: Record<string, number> = {};
  let maxConfidence = 0;
  for (const f of findings) {
    categories[f.category] = (categories[f.category] ?? 0) + 1;
    if (f.confidence > maxConfidence) maxConfidence = f.confidence;
  }
  return { total: findings.length, categories, maxConfidence };
}

/** Drop findings a policy would never enforce on (wrong category / too weak),
 *  so audit and enforcement see the same set. */
export function filterByPolicy(findings: Finding[], policy: GuardrailPolicy): Finding[] {
  const min = policy.minConfidence ?? 0;
  const cats = policy.categories ? new Set(policy.categories) : undefined;
  return findings.filter((f) => f.confidence >= min && (!cats || cats.has(String(f.category))));
}

export interface InputInspection {
  findings: Finding[];
  summary: FindingSummary;
  blocked: boolean;
  blockedReason?: string;
  /** Rewritten body text to forward upstream (mask / redact). */
  transformedText?: string;
  /** Present for `mask`: restores originals in the response. */
  vault?: TokenVault;
  plugin?: { name: string; result: GuardrailPluginResult };
}

export interface OutputInspection {
  findings: Finding[];
  summary: FindingSummary;
  blocked: boolean;
  /** Rewritten (redacted) response text, when the output policy transforms. */
  transformedText?: string;
}

/**
 * Runs the configured detectors (and optional provider plugin) against request
 * and response text, applying the direction's policy. Audit-only never mutates;
 * block/mask/redact do. The default policies are audit in both directions.
 */
export class GuardrailEngine {
  constructor(
    private readonly detectors: Detector[],
    private readonly policies: GuardrailPolicies,
    private readonly plugin?: GuardrailPlugin,
  ) {}

  get outputPolicy(): GuardrailPolicy {
    return this.policies.output;
  }

  /** A single Detector that fans out to all configured detectors and resolves
   *  overlaps — for the streaming output scanner. */
  combinedDetector(): Detector {
    const detectors = this.detectors;
    return {
      name: 'combined',
      detect(text: string): Finding[] {
        const all: Finding[] = [];
        for (const d of detectors) all.push(...d.detect(text));
        return resolveOverlaps(all);
      },
    };
  }

  private detectAll(text: string): Finding[] {
    const all: Finding[] = [];
    for (const d of this.detectors) all.push(...d.detect(text));
    return resolveOverlaps(all);
  }

  async inspectInput(text: string): Promise<InputInspection> {
    const policy = this.policies.input;
    let findings = filterByPolicy(this.detectAll(text), policy);

    let plugin: InputInspection['plugin'];
    if (this.plugin) {
      const result = await this.plugin.inspect(text, 'input');
      plugin = { name: this.plugin.name, result };
      if (result.findings.length > 0) {
        findings = resolveOverlaps([...findings, ...result.findings]);
      }
    }

    const summary = summarize(findings);
    const pluginBlocked = plugin?.result.action === 'blocked';

    if (pluginBlocked) {
      return {
        findings,
        summary,
        blocked: true,
        blockedReason: `blocked by ${plugin?.name}`,
        plugin,
      };
    }
    if (policy.action === 'block' && findings.length > 0) {
      return {
        findings,
        summary,
        blocked: true,
        blockedReason: 'input contained restricted content',
        plugin,
      };
    }
    if (policy.action === 'mask' && findings.length > 0) {
      const vault = new TokenVault();
      return {
        findings,
        summary,
        blocked: false,
        transformedText: vault.tokenize(text, findings),
        vault,
        plugin,
      };
    }
    if (policy.action === 'redact' && findings.length > 0) {
      return {
        findings,
        summary,
        blocked: false,
        transformedText: redactText(text, findings),
        plugin,
      };
    }
    if (plugin?.result.action === 'masked' && plugin.result.maskedText !== undefined) {
      return {
        findings,
        summary,
        blocked: false,
        transformedText: plugin.result.maskedText,
        plugin,
      };
    }
    return { findings, summary, blocked: false, plugin };
  }

  /** Non-streaming / buffered output enforcement. Output `mask` redacts toward
   *  the client (returning tokens to the caller would leak nothing useful). */
  inspectOutputText(text: string): OutputInspection {
    const policy = this.policies.output;
    const findings = filterByPolicy(this.detectAll(text), policy);
    const summary = summarize(findings);
    if (findings.length === 0) return { findings, summary, blocked: false };
    if (policy.action === 'block') return { findings, summary, blocked: true };
    if (policy.action === 'mask' || policy.action === 'redact') {
      return { findings, summary, blocked: false, transformedText: redactText(text, findings) };
    }
    return { findings, summary, blocked: false };
  }
}
