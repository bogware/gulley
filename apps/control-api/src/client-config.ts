/**
 * Generated client config — turnkey onboarding for a coding agent behind Gulley.
 *
 * Emits the settings a developer drops in so Claude Code or Codex points at the
 * gateway (base-URL change) with the team's allowed models surfaced. This is the
 * config GENERATION; the signed `gulley init` onboarding packs (a separate feature)
 * deliver + sign a full bundle built on top of this. Pure + unit-tested — no I/O.
 */

export type ClientAgent = 'claude-code' | 'codex';

export interface ClientConfigInput {
  agent: ClientAgent;
  /** The gateway's public base URL (no trailing slash), e.g. https://gulley.acme.internal. */
  gatewayUrl: string;
  /** Models the team may use (from the central model policy's allow-list). Surfaced
   *  to the developer; the gateway is the authority that enforces allow/deny. */
  allowedModels?: string[];
  /** Virtual-key prefix (gk_…) to reference in the instructions — never the secret. */
  keyPrefix?: string;
}

export interface GeneratedClientConfig {
  agent: ClientAgent;
  /** Where the developer places `content` (e.g. .claude/settings.json). */
  path: string;
  format: 'json' | 'toml';
  content: string;
  /** Human setup notes (auth token, allowed models) — not part of the file. */
  notes: string[];
}

function trimUrl(u: string): string {
  return u.replace(/\/+$/, '');
}

/**
 * Generate the client config for one agent. Claude Code takes an
 * `.claude/settings.json` whose `env` repoints ANTHROPIC_BASE_URL at the gateway;
 * Codex takes a `~/.codex/config.toml` custom model provider pointing at the
 * gateway's OpenAI-compatible path. The virtual-key SECRET is never emitted — the
 * developer supplies it via the documented env var.
 */
export function generateClientConfig(input: ClientConfigInput): GeneratedClientConfig {
  const gatewayUrl = trimUrl(input.gatewayUrl);
  const models = input.allowedModels ?? [];
  const modelsNote =
    models.length > 0
      ? `Your team may use: ${models.join(', ')} (the gateway enforces this).`
      : 'Model access is governed centrally by the gateway policy.';
  const keyNote = input.keyPrefix
    ? `Set your virtual key (starts with ${input.keyPrefix}) — never commit it.`
    : 'Set your Gulley virtual key — never commit it.';

  if (input.agent === 'codex') {
    // Codex reads ~/.codex/config.toml. A custom provider repoints the base URL at
    // the gateway's OpenAI-compatible surface; the key comes from an env var.
    const content = [
      'model_provider = "gulley"',
      '',
      '[model_providers.gulley]',
      'name = "Gulley"',
      `base_url = "${gatewayUrl}/openai/v1"`,
      'env_key = "GULLEY_API_KEY"',
      'wire_api = "chat"',
      '',
    ].join('\n');
    return {
      agent: 'codex',
      path: '~/.codex/config.toml',
      format: 'toml',
      content,
      notes: [`export GULLEY_API_KEY=<your ${input.keyPrefix ?? 'gk_'}… key>`, keyNote, modelsNote],
    };
  }

  // Claude Code reads .claude/settings.json; `env` repoints the Anthropic base URL.
  const settings: Record<string, unknown> = {
    env: {
      ANTHROPIC_BASE_URL: gatewayUrl,
      ANTHROPIC_AUTH_TOKEN: '${GULLEY_API_KEY}',
    },
  };
  if (models.length > 0)
    settings['env'] = { ...(settings['env'] as object), GULLEY_ALLOWED_MODELS: models.join(',') };
  return {
    agent: 'claude-code',
    path: '.claude/settings.json',
    format: 'json',
    content: `${JSON.stringify(settings, null, 2)}\n`,
    notes: [`export GULLEY_API_KEY=<your ${input.keyPrefix ?? 'gk_'}… key>`, keyNote, modelsNote],
  };
}
