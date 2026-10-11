import { describe, expect, it } from 'vitest';
import {
  conversationFingerprint,
  conversationIdentity,
  deriveVaultMaster,
  maskVaultKey,
} from './conversation';

const body = (over: Record<string, unknown> = {}) => ({
  model: 'claude-sonnet-5-5',
  system: [{ type: 'text', text: 'You are Claude Code', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: 'hi jane@example.com' }],
  ...over,
});

describe('conversationIdentity', () => {
  it('prefers an explicit id header: x-gulley-conversation-id, then the Claude Code session id', () => {
    expect(
      conversationIdentity(
        { 'x-gulley-conversation-id': 'conv-1', 'x-claude-code-session-id': 'sess-1' },
        body(),
        true,
        'vk_1',
      ),
    ).toEqual({ id: 'conv:conv-1', source: 'header' });
    expect(
      conversationIdentity({ 'x-claude-code-session-id': 'sess-1' }, body(), true, 'vk_1'),
    ).toEqual({ id: 'session:sess-1', source: 'header' });
    // Repeated header: first value wins.
    expect(
      conversationIdentity({ 'x-claude-code-session-id': ['a', 'b'] }, body(), true, 'vk_1').id,
    ).toBe('session:a');
  });

  it('ignores a header value that is not bounded printable ASCII (falls through)', () => {
    for (const bad of ['', ' has space', 'x'.repeat(129), 'tab\there', 'ünïcode']) {
      const id = conversationIdentity({ 'x-claude-code-session-id': bad }, body(), true, 'vk_1');
      expect(id.source).toBe('fingerprint');
    }
  });

  it('fingerprints the system prompt + first user turn when no header is present', () => {
    const a = conversationIdentity({}, body(), true, 'vk_1');
    expect(a.source).toBe('fingerprint');
    expect(a.id).toMatch(/^fp:[0-9a-f]{32}$/);
    // Turn 2: same prefix, more history ⇒ same identity.
    const turn2 = body({
      messages: [
        { role: 'user', content: 'hi jane@example.com' },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        { role: 'user', content: 'more' },
      ],
    });
    expect(conversationIdentity({}, turn2, true, 'vk_1').id).toBe(a.id);
    // A different first user turn or system prompt ⇒ a different conversation.
    expect(
      conversationIdentity(
        {},
        body({ messages: [{ role: 'user', content: 'other' }] }),
        true,
        'vk_1',
      ).id,
    ).not.toBe(a.id);
    expect(conversationIdentity({}, body({ system: 'different' }), true, 'vk_1').id).not.toBe(a.id);
  });

  it('is insensitive to cache_control markers and key order (not edits under the prefix rules)', () => {
    const base = conversationFingerprint(body());
    expect(
      conversationFingerprint(
        body({ system: [{ text: 'You are Claude Code', type: 'text' }] }), // no cache_control, keys reordered
      ),
    ).toBe(base);
    expect(
      conversationFingerprint(
        body({
          messages: [
            { content: 'hi jane@example.com', role: 'user', cache_control: { type: 'ephemeral' } },
          ],
        }),
      ),
    ).toBe(base);
  });

  it('understands OpenAI chat (system in messages) and Responses (instructions + input)', () => {
    const chat = {
      model: 'gpt-5.4',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'first' },
      ],
    };
    const chat2 = {
      model: 'gpt-5.4',
      messages: [
        ...chat.messages,
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'b' },
      ],
    };
    expect(conversationFingerprint(chat)).toBe(conversationFingerprint(chat2));
    const resp = { model: 'gpt-5.4', instructions: 'sys', input: 'first' };
    const respItems = {
      model: 'gpt-5.4',
      instructions: 'sys',
      input: [{ role: 'user', content: 'first' }],
    };
    expect(conversationFingerprint(resp)).toBeDefined();
    expect(conversationFingerprint(respItems)).toBeDefined();
    expect(conversationFingerprint(resp)).toBe(conversationFingerprint(respItems));
  });

  it('falls back to the principal when there is no user turn or the body did not parse', () => {
    expect(conversationIdentity({}, { model: 'm', input: 'x' }, false, 'vk_1')).toEqual({
      id: 'principal:vk_1',
      source: 'principal',
    });
    expect(conversationIdentity({}, { model: 'm', messages: [] }, true, 'vk_1').source).toBe(
      'principal',
    );
    expect(conversationIdentity({}, { model: 'm', input: 'x' }, true, 'vk_1').source).toBe(
      'fingerprint',
    );
  });
});

describe('maskVaultKey', () => {
  it('derives a 32-byte key scoped by workspace AND conversation, stable across replicas', () => {
    const master = deriveVaultMaster('the-deployment-pepper-value');
    expect(master).toHaveLength(32);
    expect(deriveVaultMaster('the-deployment-pepper-value').equals(master)).toBe(true);
    const conv = { id: 'session:abc', source: 'header' as const };
    const k1 = maskVaultKey(master, 'ws1', conv);
    expect(k1).toHaveLength(32);
    expect(maskVaultKey(master, 'ws1', conv).equals(k1)).toBe(true);
    expect(maskVaultKey(master, 'ws2', conv).equals(k1)).toBe(false);
    expect(maskVaultKey(master, 'ws1', { id: 'session:abd', source: 'header' }).equals(k1)).toBe(
      false,
    );
    expect(maskVaultKey(deriveVaultMaster('other-pepper-value'), 'ws1', conv).equals(k1)).toBe(
      false,
    );
  });
});
