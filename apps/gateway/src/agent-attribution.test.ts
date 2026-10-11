import { describe, expect, it } from 'vitest';
import { agentAttribution, agentProduct } from './agent-attribution';

describe('agentAttribution', () => {
  it('maps Claude Code headers to stable attribution keys and tags the agent product', () => {
    expect(
      agentAttribution({
        'x-claude-code-session-id': 'sess-1',
        'x-claude-code-agent-id': 'agent-9',
        'x-claude-code-parent-agent-id': 'agent-1',
        'x-claude-code-prompt-id': '6f1a2b3c-0000-4000-8000-000000000000',
        'x-claude-code-request-class': 'subagent',
        'x-claude-code-agent-type': 'Explore',
        'x-claude-code-compaction': 'auto',
        'x-claude-code-prev-tool-durations': 'Bash=742;Read=9',
        'user-agent': 'claude-cli/2.1.300 (external, cli)',
      }),
    ).toEqual({
      session: 'sess-1',
      cc_agent: 'agent-9',
      cc_parent_agent: 'agent-1',
      prompt: '6f1a2b3c-0000-4000-8000-000000000000',
      request_class: 'subagent',
      agent_type: 'Explore',
      compaction: 'auto',
      agent: 'claude-code',
    });
  });

  it('identifies Codex by its originator header or user agent, and nothing for a plain SDK', () => {
    expect(agentAttribution({ originator: 'codex_cli_rs' })).toEqual({ agent: 'codex' });
    expect(agentProduct({ 'user-agent': 'codex_cli_rs/0.40.0' })).toBe('codex');
    expect(agentAttribution({ 'user-agent': 'anthropic-sdk-python/0.60' })).toBeUndefined();
    expect(agentAttribution({})).toBeUndefined();
  });

  it('drops a value that is over-long, non-printable or hash-tag-unsafe (repeated header: first wins)', () => {
    expect(agentAttribution({ 'x-claude-code-session-id': 'x'.repeat(129) })).toEqual({
      agent: 'claude-code',
    });
    expect(agentAttribution({ 'x-claude-code-session-id': 'bad{tag}' })).toEqual({
      agent: 'claude-code',
    });
    expect(agentAttribution({ 'x-claude-code-session-id': 'tab\there' })).toEqual({
      agent: 'claude-code',
    });
    expect(agentAttribution({ 'x-claude-code-session-id': ['a', 'b'] })).toEqual({
      session: 'a',
      agent: 'claude-code',
    });
  });
});
