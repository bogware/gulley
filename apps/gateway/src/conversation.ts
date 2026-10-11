import { createHash, createHmac } from 'node:crypto';
import { deriveVaultKey } from '@gulley/guardrails';

/**
 * Conversation identity (K2 — conversation-stable masking).
 *
 * The guardrail `mask` action derives every token from a per-conversation key, so
 * the same value masks to the same token on every turn of a conversation. That
 * keeps the masked request prefix identical turn after turn, which is what the
 * provider's prompt cache AND the Claude 5.5-generation preserved-thinking prefix
 * check (`system`, `tools`, earlier `messages` must match the request that
 * produced a thinking block) both require. A per-request random token broke both:
 * every masked multi-turn conversation missed its cache prefix and, on Opus 5.5 /
 * Sonnet 5.5 / Fable 5.1, was rejected with "bound to a different conversation".
 *
 * Key source, in precedence order:
 *   1. an explicit id header — `x-gulley-conversation-id`, else Claude Code's
 *      `x-claude-code-session-id` (one id per Claude Code session);
 *   2. a fingerprint of the conversation's fixed prefix — the system prompt and
 *      the first user message (with `cache_control` markers ignored), which the
 *      preserved-thinking rules already forbid a client from changing mid-conversation;
 *   3. the principal (virtual key): still reversible only through the vault, but
 *      tokens then repeat across that key's conversations.
 *
 * The derived key is ALSO scoped by workspace, so a value shared by two tenants
 * never shares a token. The identity doubles as the default load-balancer
 * session-affinity key, so a conversation stays on one provider (thinking
 * signatures and prompt caches are provider-bound).
 */
export type ConversationSource = 'header' | 'fingerprint' | 'principal';

export interface ConversationIdentity {
  /** Stable, bounded, printable-ASCII id prefixed by its kind (`session:`, `conv:`,
   *  `fp:`, `principal:`) so ids from different sources can never collide. */
  id: string;
  source: ConversationSource;
}

/** Explicit-id request headers, in precedence order. */
export const CONVERSATION_ID_HEADERS = [
  'x-gulley-conversation-id',
  'x-claude-code-session-id',
] as const;

/** 1–128 printable ASCII characters, no whitespace (the id becomes part of a key
 *  derivation scope and a Redis/HRW affinity key, so it must stay bounded and
 *  byte-clean). */
const ID_RE = /^[\x21-\x7e]{1,128}$/;

type Headers = Record<string, string | string[] | undefined>;

export function conversationIdentity(
  headers: Headers,
  parsed: Record<string, unknown>,
  parseOk: boolean,
  principalId: string,
): ConversationIdentity {
  for (const name of CONVERSATION_ID_HEADERS) {
    const raw = headers[name];
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (typeof v === 'string' && ID_RE.test(v)) {
      return {
        id: `${name === 'x-claude-code-session-id' ? 'session' : 'conv'}:${v}`,
        source: 'header',
      };
    }
  }
  if (parseOk) {
    const fp = conversationFingerprint(parsed);
    if (fp) return { id: `fp:${fp}`, source: 'fingerprint' };
  }
  return { id: `principal:${principalId}`, source: 'principal' };
}

/** SHA-256 (truncated to 128 bits) over the system prompt and the first user
 *  turn of an Anthropic Messages, OpenAI chat, or Responses body — the part of a
 *  conversation that stays fixed for its lifetime. Undefined when the body has no
 *  user turn (nothing stable to key on). */
export function conversationFingerprint(parsed: Record<string, unknown>): string | undefined {
  const topSystem = parsed['system'] ?? parsed['instructions'];
  const input = parsed['input'];
  const turns = Array.isArray(parsed['messages'])
    ? parsed['messages']
    : Array.isArray(input)
      ? input
      : undefined;
  let systemFromTurns: unknown;
  let firstUser: unknown;
  if (turns) {
    for (const t of turns) {
      if (!t || typeof t !== 'object') continue;
      const turn = t as Record<string, unknown>;
      if (turn['role'] === 'system' && systemFromTurns === undefined) {
        systemFromTurns = turn['content'];
      } else if (turn['role'] === 'user') {
        firstUser = turn['content'];
        break;
      }
    }
  } else if (typeof input === 'string') {
    firstUser = input; // Responses shorthand: `input: "…"` is the first user turn
  }
  if (firstUser === undefined) return undefined;
  const h = createHash('sha256');
  h.update(stableJson(topSystem ?? systemFromTurns ?? null));
  h.update('\u0000');
  h.update(stableJson(firstUser));
  return h.digest('hex').slice(0, 32);
}

/** Deterministic JSON: keys sorted, `cache_control` markers dropped (a client may
 *  add, move or remove them between turns without that being an edit). */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (key, v) => {
    if (key === 'cache_control') return undefined;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(o)
          .sort()
          .map((k) => [k, o[k]]),
      );
    }
    return v as unknown;
  });
}

/** The deployment-wide mask-vault master secret, derived from the key pepper every
 *  replica already shares (`GULLEY_KEY_PEPPER`) under its own label so the pepper
 *  itself is never used as an HMAC key directly. */
export function deriveVaultMaster(pepper: string): Buffer {
  return createHmac('sha256', Buffer.from(pepper, 'utf8'))
    .update('gulley-mask-vault-master-v1')
    .digest();
}

/** The per-conversation vault key: scoped by workspace AND conversation id. */
export function maskVaultKey(
  master: Uint8Array,
  workspaceId: string,
  conversation: ConversationIdentity,
): Buffer {
  return deriveVaultKey(master, `${workspaceId}\u0000${conversation.id}`);
}
