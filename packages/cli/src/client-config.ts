/**
 * Generated client config — turnkey onboarding for a coding agent behind Gulley.
 *
 * Emits the settings a developer drops in so Claude Code or Codex points at the
 * gateway (a base-URL change) in one of two auth modes:
 *
 *   - `virtual-key`: the developer exports a static `gk_` virtual key. The SECRET is
 *     never written into a settings file.
 *   - `oauth`: gateway-brokered OAuth (device flow). The settings file wires the
 *     agent's *token helper* to `gulley token`, which prints a short-lived `gko_at_`
 *     access token (refreshing it through the broker as needed). The developer runs
 *     `gulley login` once.
 *
 * Facts this generator depends on (verified against the vendors' docs, Sep 2026):
 *   - Claude Code does NOT expand `${VAR}` inside `settings.json` → `env`, and a
 *     settings-file `env` value OVERRIDES a shell export. So a token must never be
 *     placed there as a placeholder — it would be sent literally. `apiKeyHelper` is the
 *     supported way to inject a rotating credential (re-run every
 *     CLAUDE_CODE_API_KEY_HELPER_TTL_MS, default 5 min); its output is sent as BOTH
 *     `Authorization: Bearer` and `x-api-key`.
 *   - Codex's `[model_providers.<id>]` only supports `wire_api = "responses"` (the
 *     former "chat" variant no longer exists); `base_url` is the full `/v1` path;
 *     `env_key` names an env var sent as a Bearer; `[model_providers.<id>.auth]`
 *     runs a command that prints the bearer to stdout (`refresh_interval_ms`).
 *
 * Pure + unit-tested — no I/O. Shared by the control-api (client-config / onboarding
 * pack endpoints) and the `gulley` CLI.
 */

export type ClientAgent = 'claude-code' | 'codex';
export type ClientAuthMode = 'virtual-key' | 'oauth';

export interface ClientConfigInput {
  agent: ClientAgent;
  /** The gateway's public base URL (no trailing slash), e.g. https://gulley.acme.internal. */
  gatewayUrl: string;
  /** Models the team may use (from the central model policy's allow-list). Surfaced
   *  to the developer; the gateway is the authority that enforces allow/deny. */
  allowedModels?: string[];
  /** Virtual-key prefix (gk_…) to reference in the instructions — never the secret. */
  keyPrefix?: string;
  /** Auth mode. Default `virtual-key`. */
  auth?: ClientAuthMode;
  /** OAuth mode: the broker's public base URL (the control-api), e.g.
   *  https://api.gulley.acme.internal. Its RFC 8414 metadata lives at
   *  /.well-known/oauth-authorization-server. */
  brokerUrl?: string;
  /** OAuth mode: the registered client id. Defaults to the agent name. */
  clientId?: string;
  /** OAuth mode: the `gulley` credential profile to use (`gulley token --profile X`).
   *  Defaults to the client id so two brokers/clients never share a token cache. */
  profile?: string;
}

export interface GeneratedClientConfig {
  agent: ClientAgent;
  auth: ClientAuthMode;
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

/** Codex (TOML) config identity: the provider table id. Exported so `gulley init`
 *  can splice/replace exactly this table in an existing config.toml. */
export const CODEX_PROVIDER_ID = 'gulley';

/** Five minutes — matches Claude Code's default apiKeyHelper TTL and Codex's default
 *  auth refresh interval, and stays far inside the broker's access-token TTL (1h). */
export const TOKEN_HELPER_REFRESH_MS = 300_000;

export function tokenHelperCommand(profile: string): { command: string; args: string[] } {
  return { command: 'gulley', args: ['token', '--profile', profile] };
}

/**
 * Generate the client config for one agent + auth mode. Claude Code takes an
 * `.claude/settings.json` whose `env` repoints ANTHROPIC_BASE_URL at the gateway
 * (and, in OAuth mode, an `apiKeyHelper`); Codex takes a `~/.codex/config.toml`
 * custom model provider pointing at the gateway's OpenAI-compatible surface (and, in
 * OAuth mode, an `auth` command). No secret is ever emitted.
 */
export function generateClientConfig(input: ClientConfigInput): GeneratedClientConfig {
  const gatewayUrl = trimUrl(input.gatewayUrl);
  const auth: ClientAuthMode = input.auth ?? 'virtual-key';
  const models = input.allowedModels ?? [];
  const clientId = input.clientId ?? input.agent;
  const profile = input.profile ?? clientId;
  const brokerUrl = input.brokerUrl ? trimUrl(input.brokerUrl) : undefined;
  const helper = tokenHelperCommand(profile);
  const helperLine = [helper.command, ...helper.args].join(' ');

  const modelsNote =
    models.length > 0
      ? `Your team may use: ${models.join(', ')} (the gateway enforces this).`
      : 'Model access is governed centrally by the gateway policy.';
  const loginNote = brokerUrl
    ? `Sign in once: gulley login --broker ${brokerUrl} --client ${clientId} --profile ${profile}`
    : `Sign in once: gulley login --broker <control-api URL> --client ${clientId} --profile ${profile}`;
  const helperNote = `The agent runs "${helperLine}" for a short-lived gko_at_ token (refreshed every ${
    TOKEN_HELPER_REFRESH_MS / 60_000
  } min) — install the CLI so "gulley" is on PATH (see docs/HARNESS_OAUTH.md).`;

  if (input.agent === 'codex') {
    // Codex reads ~/.codex/config.toml. A custom provider repoints the base URL at the
    // gateway's OpenAI-compatible surface (Responses wire API — the only one Codex
    // supports for custom providers); the credential comes from an env var (virtual
    // key) or from the `auth` token command (OAuth).
    const lines = [
      `model_provider = "${CODEX_PROVIDER_ID}"`,
      '',
      `[model_providers.${CODEX_PROVIDER_ID}]`,
      'name = "Gulley"',
      `base_url = "${gatewayUrl}/openai/v1"`,
      'wire_api = "responses"',
      `stream_idle_timeout_ms = ${TOKEN_HELPER_REFRESH_MS}`,
    ];
    if (auth === 'virtual-key') {
      lines.push('env_key = "GULLEY_API_KEY"');
    } else {
      lines.push(
        '',
        `[model_providers.${CODEX_PROVIDER_ID}.auth]`,
        `command = "${helper.command}"`,
        `args = [${helper.args.map((a) => `"${a}"`).join(', ')}]`,
        'timeout_ms = 10000',
        `refresh_interval_ms = ${TOKEN_HELPER_REFRESH_MS}`,
      );
    }
    lines.push('');
    const notes =
      auth === 'virtual-key'
        ? [
            `export GULLEY_API_KEY=<your ${input.keyPrefix ?? 'gk_'}… key>  (never commit it)`,
            modelsNote,
          ]
        : [loginNote, helperNote, modelsNote];
    return {
      agent: 'codex',
      auth,
      path: '~/.codex/config.toml',
      format: 'toml',
      content: lines.join('\n'),
      notes,
    };
  }

  // Claude Code reads .claude/settings.json; `env` repoints the Anthropic base URL.
  // Never place a credential (or a `${VAR}` placeholder — not expanded, and it would
  // override a shell export) in `env`.
  const env: Record<string, string> = { ANTHROPIC_BASE_URL: gatewayUrl };
  const settings: Record<string, unknown> = { env };
  if (auth === 'oauth') {
    env['CLAUDE_CODE_API_KEY_HELPER_TTL_MS'] = String(TOKEN_HELPER_REFRESH_MS);
    settings['apiKeyHelper'] = helperLine;
  }
  const notes =
    auth === 'virtual-key'
      ? [
          `export ANTHROPIC_AUTH_TOKEN=<your ${input.keyPrefix ?? 'gk_'}… key>  (never commit it; sent as a Bearer)`,
          modelsNote,
        ]
      : [loginNote, helperNote, modelsNote];
  return {
    agent: 'claude-code',
    auth,
    path: '.claude/settings.json',
    format: 'json',
    content: `${JSON.stringify(settings, null, 2)}\n`,
    notes,
  };
}

/**
 * Merge a generated Claude Code settings document into an EXISTING settings.json so
 * `gulley init` never clobbers a developer's other settings: `env` keys are merged
 * (ours win), `apiKeyHelper` is set only when we generate one, everything else is
 * preserved. Throws on unparseable existing content (the caller refuses to write).
 */
export function mergeClaudeSettings(existing: string | undefined, generated: string): string {
  const next = JSON.parse(generated) as { env?: Record<string, string>; apiKeyHelper?: string };
  let base: Record<string, unknown> = {};
  if (existing && existing.trim()) {
    const parsed = JSON.parse(existing) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      base = parsed as Record<string, unknown>;
    }
  }
  const baseEnv =
    base['env'] && typeof base['env'] === 'object' ? (base['env'] as Record<string, unknown>) : {};
  const merged: Record<string, unknown> = { ...base, env: { ...baseEnv, ...(next.env ?? {}) } };
  if (next.apiKeyHelper) merged['apiKeyHelper'] = next.apiKeyHelper;
  return `${JSON.stringify(merged, null, 2)}\n`;
}

/**
 * Splice the generated Codex provider into an EXISTING config.toml: replaces any
 * previous `[model_providers.gulley]` (+ `.auth`) tables and the top-level
 * `model_provider` line, preserving every other table verbatim. Line-based on
 * purpose (a TOML round-trip parser would reformat the developer's file).
 */
export function mergeCodexConfig(existing: string | undefined, generated: string): string {
  if (!existing || !existing.trim()) return generated;
  const gen = generated.split('\n');
  const providerLine = gen.find((l) => /^model_provider\s*=/.test(l)) ?? '';
  const tableStart = gen.findIndex((l) => l.trim() === `[model_providers.${CODEX_PROVIDER_ID}]`);
  const tables = gen.slice(tableStart).join('\n').trimEnd();

  const out: string[] = [];
  let skipping = false;
  let inTopLevel = true;
  let sawProviderLine = false;
  for (const line of existing.split('\n')) {
    const t = line.trim();
    if (/^\[.*\]$/.test(t)) {
      inTopLevel = false;
      skipping =
        t === `[model_providers.${CODEX_PROVIDER_ID}]` ||
        t.startsWith(`[model_providers.${CODEX_PROVIDER_ID}.`);
      if (skipping) continue;
    }
    if (skipping) continue;
    if (inTopLevel && /^model_provider\s*=/.test(t)) {
      if (!sawProviderLine) out.push(providerLine);
      sawProviderLine = true;
      continue;
    }
    out.push(line);
  }
  let body = out.join('\n').trimEnd();
  if (!sawProviderLine) body = `${providerLine}\n${body}`;
  return `${body}\n\n${tables}\n`;
}
