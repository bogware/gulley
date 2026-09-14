import { describe, expect, it } from 'vitest';
import { generateClientConfig, mergeClaudeSettings, mergeCodexConfig } from './client-config';

describe('generateClientConfig — Claude Code', () => {
  it('virtual-key: repoints the base URL and NEVER places a credential or placeholder in env', () => {
    const cfg = generateClientConfig({
      agent: 'claude-code',
      gatewayUrl: 'https://gulley.acme.internal/',
      allowedModels: ['claude-sonnet-4-6', 'claude-opus-4-8'],
      keyPrefix: 'gk_ab',
    });
    expect(cfg.path).toBe('.claude/settings.json');
    expect(cfg.format).toBe('json');
    expect(cfg.auth).toBe('virtual-key');
    const parsed = JSON.parse(cfg.content) as {
      env: Record<string, string>;
      apiKeyHelper?: string;
    };
    // Trailing slash trimmed; base URL repointed at the gateway.
    expect(parsed.env['ANTHROPIC_BASE_URL']).toBe('https://gulley.acme.internal');
    // Claude Code does not expand ${VAR} in settings env (and a settings value beats a
    // shell export) — a placeholder there would be sent literally and 401 forever.
    expect(parsed.env['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
    expect(parsed.env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(cfg.content).not.toContain('${');
    expect(parsed.apiKeyHelper).toBeUndefined();
    // The secret is never emitted; notes tell the developer to EXPORT the key.
    expect(cfg.content).not.toContain('gk_ab');
    expect(cfg.notes.join(' ')).toContain('export ANTHROPIC_AUTH_TOKEN=');
    expect(cfg.notes.join(' ')).toContain('claude-sonnet-4-6');
  });

  it('oauth: wires apiKeyHelper to `gulley token` with a 5-minute TTL', () => {
    const cfg = generateClientConfig({
      agent: 'claude-code',
      gatewayUrl: 'https://gulley.acme.internal',
      auth: 'oauth',
      brokerUrl: 'https://api.gulley.acme.internal/',
      clientId: 'claude-code',
    });
    expect(cfg.auth).toBe('oauth');
    const parsed = JSON.parse(cfg.content) as { env: Record<string, string>; apiKeyHelper: string };
    expect(parsed.apiKeyHelper).toBe('gulley token --profile claude-code');
    expect(parsed.env['CLAUDE_CODE_API_KEY_HELPER_TTL_MS']).toBe('300000');
    expect(parsed.env['ANTHROPIC_BASE_URL']).toBe('https://gulley.acme.internal');
    expect(cfg.notes.join('\n')).toContain(
      'gulley login --broker https://api.gulley.acme.internal --client claude-code --profile claude-code',
    );
  });

  it('omits the models note when no allowed models are given', () => {
    const cfg = generateClientConfig({ agent: 'claude-code', gatewayUrl: 'https://g' });
    expect(cfg.notes.join(' ')).toContain('governed centrally');
  });
});

describe('generateClientConfig — Codex', () => {
  it('virtual-key: a Responses-wire custom provider with an env_key credential', () => {
    const cfg = generateClientConfig({
      agent: 'codex',
      gatewayUrl: 'https://gulley.acme.internal',
      allowedModels: ['gpt-4o'],
    });
    expect(cfg.path).toBe('~/.codex/config.toml');
    expect(cfg.format).toBe('toml');
    expect(cfg.content).toContain('model_provider = "gulley"');
    expect(cfg.content).toContain('base_url = "https://gulley.acme.internal/openai/v1"');
    // Codex's WireApi enum only has `responses` — "chat" fails to parse the whole file.
    expect(cfg.content).toContain('wire_api = "responses"');
    expect(cfg.content).not.toContain('wire_api = "chat"');
    expect(cfg.content).toContain('env_key = "GULLEY_API_KEY"');
    expect(cfg.content).not.toContain('[model_providers.gulley.auth]');
  });

  it('oauth: an auth command table running `gulley token` instead of env_key', () => {
    const cfg = generateClientConfig({
      agent: 'codex',
      gatewayUrl: 'https://gulley.acme.internal',
      auth: 'oauth',
      brokerUrl: 'https://api.gulley.acme.internal',
    });
    expect(cfg.content).not.toContain('env_key');
    expect(cfg.content).toContain('[model_providers.gulley.auth]');
    expect(cfg.content).toContain('command = "gulley"');
    expect(cfg.content).toContain('args = ["token", "--profile", "codex"]');
    expect(cfg.content).toContain('refresh_interval_ms = 300000');
  });
});

describe('merge helpers (gulley init never clobbers a developer config)', () => {
  it('merges Claude settings: keeps other keys + env, ours win, apiKeyHelper set', () => {
    const existing = JSON.stringify({
      permissions: { allow: ['Bash'] },
      env: { EDITOR: 'vim', ANTHROPIC_BASE_URL: 'https://old' },
    });
    const gen = generateClientConfig({
      agent: 'claude-code',
      gatewayUrl: 'https://new',
      auth: 'oauth',
    }).content;
    const merged = JSON.parse(mergeClaudeSettings(existing, gen)) as Record<string, unknown>;
    expect(merged['permissions']).toEqual({ allow: ['Bash'] });
    expect(merged['env']).toMatchObject({ EDITOR: 'vim', ANTHROPIC_BASE_URL: 'https://new' });
    expect(merged['apiKeyHelper']).toBe('gulley token --profile claude-code');
    // No existing file ⇒ the generated document verbatim.
    expect(mergeClaudeSettings(undefined, gen)).toBe(gen);
  });

  it('splices the Codex provider tables, replacing a previous gulley table only', () => {
    const existing = [
      'model = "gpt-5-codex"',
      'model_provider = "openai"',
      '',
      '[model_providers.gulley]',
      'name = "Old Gulley"',
      'base_url = "https://old/openai/v1"',
      'wire_api = "chat"',
      '',
      '[model_providers.ollama]',
      'name = "Ollama"',
      'base_url = "http://localhost:11434/v1"',
      '',
    ].join('\n');
    const gen = generateClientConfig({ agent: 'codex', gatewayUrl: 'https://new' }).content;
    const merged = mergeCodexConfig(existing, gen);
    expect(merged).toContain('model = "gpt-5-codex"');
    expect(merged).toContain('model_provider = "gulley"');
    expect(merged).not.toContain('model_provider = "openai"');
    expect(merged).not.toContain('Old Gulley');
    expect(merged).not.toContain('wire_api = "chat"');
    expect(merged).toContain('[model_providers.ollama]');
    expect(merged).toContain('base_url = "https://new/openai/v1"');
    expect((merged.match(/\[model_providers\.gulley\]/g) ?? []).length).toBe(1);
    expect(mergeCodexConfig('', gen)).toBe(gen);
  });
});
