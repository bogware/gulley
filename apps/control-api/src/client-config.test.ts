import { describe, expect, it } from 'vitest';
import { generateClientConfig } from './client-config';

describe('generateClientConfig', () => {
  it('emits a Claude Code settings.json repointing the Anthropic base URL', () => {
    const cfg = generateClientConfig({
      agent: 'claude-code',
      gatewayUrl: 'https://gulley.acme.internal/',
      allowedModels: ['claude-sonnet-4-6', 'claude-opus-4-8'],
      keyPrefix: 'gk_ab',
    });
    expect(cfg.path).toBe('.claude/settings.json');
    expect(cfg.format).toBe('json');
    const parsed = JSON.parse(cfg.content) as { env: Record<string, string> };
    // Trailing slash trimmed; base URL repointed at the gateway.
    expect(parsed.env['ANTHROPIC_BASE_URL']).toBe('https://gulley.acme.internal');
    expect(parsed.env['ANTHROPIC_AUTH_TOKEN']).toBe('${GULLEY_API_KEY}');
    expect(parsed.env['GULLEY_ALLOWED_MODELS']).toBe('claude-sonnet-4-6,claude-opus-4-8');
    // The secret is never emitted; notes surface the allowed models.
    expect(cfg.content).not.toContain('gk_ab');
    expect(cfg.notes.join(' ')).toContain('claude-sonnet-4-6');
  });

  it('emits a Codex config.toml custom provider pointing at the gateway', () => {
    const cfg = generateClientConfig({
      agent: 'codex',
      gatewayUrl: 'https://gulley.acme.internal',
      allowedModels: ['gpt-4o'],
    });
    expect(cfg.path).toBe('~/.codex/config.toml');
    expect(cfg.format).toBe('toml');
    expect(cfg.content).toContain('base_url = "https://gulley.acme.internal/openai/v1"');
    expect(cfg.content).toContain('model_provider = "gulley"');
    expect(cfg.content).toContain('env_key = "GULLEY_API_KEY"');
  });

  it('omits the models note when no allowed models are given', () => {
    const cfg = generateClientConfig({ agent: 'claude-code', gatewayUrl: 'https://g' });
    const parsed = JSON.parse(cfg.content) as { env: Record<string, string> };
    expect(parsed.env['GULLEY_ALLOWED_MODELS']).toBeUndefined();
    expect(cfg.notes.join(' ')).toContain('governed centrally');
  });
});
