import type { GuardrailDirection, GuardrailPlugin, GuardrailPluginResult } from './types';

/** A plugin that never flags anything — a placeholder / test double and the
 *  safe fallback when a provider guardrail is unreachable and set to fail-open. */
export class NoopGuardrailPlugin implements GuardrailPlugin {
  readonly name = 'noop';
  async inspect(_text: string, _direction: GuardrailDirection): Promise<GuardrailPluginResult> {
    return { action: 'none', findings: [] };
  }
}
