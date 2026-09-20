import type { Finding, GuardrailDirection, GuardrailPlugin, GuardrailPluginResult } from './types';

/**
 * Runs several guardrail plugins in sequence over the same text: the first block
 * short-circuits (deny wins); masks are chained so each subsequent plugin sees
 * the already-masked text; findings accumulate. Lets an operator layer native
 * detection + webhook DLP + a managed service (moderation / content-safety /
 * Bedrock Guardrails) behind the single GuardrailPlugin seam the engine expects.
 */
export class CompositeGuardrailPlugin implements GuardrailPlugin {
  readonly name = 'composite';

  constructor(private readonly plugins: GuardrailPlugin[]) {}

  async inspect(text: string, direction: GuardrailDirection): Promise<GuardrailPluginResult> {
    let current = text;
    let masked = false;
    let degraded = false;
    const findings: Finding[] = [];
    for (const plugin of this.plugins) {
      const r = await plugin.inspect(current, direction);
      findings.push(...r.findings);
      if (r.degraded) degraded = true;
      if (r.action === 'blocked') return { action: 'blocked', findings, degraded };
      if (r.action === 'masked' && r.maskedText !== undefined) {
        current = r.maskedText;
        masked = true;
      }
    }
    return masked
      ? { action: 'masked', findings, maskedText: current, degraded }
      : { action: 'none', findings, degraded };
  }
}

/** Compose zero or more plugins: undefined for none, the plugin itself for one,
 *  a composite for several. */
export function composePlugins(plugins: GuardrailPlugin[]): GuardrailPlugin | undefined {
  if (plugins.length === 0) return undefined;
  if (plugins.length === 1) return plugins[0];
  return new CompositeGuardrailPlugin(plugins);
}
