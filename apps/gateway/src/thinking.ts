/**
 * Signed-reasoning detection (Wave 1 trust fix).
 *
 * Anthropic `thinking` blocks carry a `signature` (and `redacted_thinking` blocks an
 * opaque `data` payload) that binds them to the model — and, on Sonnet 5.5 / Haiku
 * 5.5, to the account — that produced them. OpenAI Responses `reasoning` items carry
 * `encrypted_content` with the same property. When a gateway substitutes the model
 * mid-conversation (budget downshift, cascade escalation, smart re-routing) or
 * hops provider, the API silently drops that reasoning (`model_binding_mismatch`)
 * or rejects the block: the model answers without its earlier reasoning and the
 * prompt cache restarts. The substitution stages therefore PIN the requested model
 * whenever the history already carries signed reasoning (`SIGNED_THINKING_SUBSTITUTION=pin`,
 * the default); `allow` keeps the pre-Wave-1 behaviour.
 */
export type SignedThinkingSubstitution = 'pin' | 'allow';

/** True when any assistant turn in `messages[]` (Anthropic / OpenAI chat) or any
 *  item in Responses `input[]` carries model-bound reasoning. O(blocks); no
 *  serialization. */
export function hasSignedThinking(parsed: Record<string, unknown>): boolean {
  const messages = parsed['messages'];
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      const turn = m as Record<string, unknown>;
      if (turn['role'] !== 'assistant') continue;
      const content = turn['content'];
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (isSignedThinkingBlock(block)) return true;
      }
    }
  }
  const input = parsed['input'];
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const it = item as Record<string, unknown>;
      if (it['type'] === 'reasoning' && typeof it['encrypted_content'] === 'string') return true;
    }
  }
  return false;
}

function isSignedThinkingBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false;
  const b = block as Record<string, unknown>;
  const type = b['type'];
  if (type === 'thinking') return typeof b['signature'] === 'string' && b['signature'].length > 0;
  if (type === 'redacted_thinking') return typeof b['data'] === 'string';
  return false;
}
