import { describe, expect, it } from 'vitest';
import { hasSignedThinking } from './thinking';

describe('hasSignedThinking', () => {
  it('detects Anthropic thinking signatures and redacted_thinking on assistant turns only', () => {
    expect(
      hasSignedThinking({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 'SIG' }] },
        ],
      }),
    ).toBe(true);
    expect(
      hasSignedThinking({
        messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'opaque' }] }],
      }),
    ).toBe(true);
    // A thinking block without a signature (or on a user turn) is not model-bound.
    expect(
      hasSignedThinking({
        messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] }],
      }),
    ).toBe(false);
    expect(
      hasSignedThinking({
        messages: [
          { role: 'user', content: [{ type: 'thinking', thinking: 'x', signature: 'S' }] },
        ],
      }),
    ).toBe(false);
    expect(hasSignedThinking({ messages: [{ role: 'assistant', content: 'plain text' }] })).toBe(
      false,
    );
    expect(hasSignedThinking({ messages: 'nope' })).toBe(false);
    expect(hasSignedThinking({})).toBe(false);
  });

  it('detects OpenAI Responses reasoning items with encrypted_content', () => {
    expect(
      hasSignedThinking({
        input: [
          { role: 'user', content: 'hi' },
          { type: 'reasoning', encrypted_content: 'gAAAA...', summary: [] },
        ],
      }),
    ).toBe(true);
    expect(hasSignedThinking({ input: [{ type: 'reasoning', summary: [] }] })).toBe(false);
    expect(hasSignedThinking({ input: 'hi' })).toBe(false);
  });
});
