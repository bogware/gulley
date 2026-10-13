/**
 * Zero-config cost attribution for coding agents (K5 groundwork).
 *
 * Claude Code sends `x-claude-code-session-id` on every request and, for subagents,
 * `x-claude-code-agent-id` / `x-claude-code-parent-agent-id`; with
 * `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` it adds routing hints (`-request-class`,
 * `-agent-type`, `-prompt-id`, `-compaction`, `-context-compacted`,
 * `-prev-tool-durations`). Anthropic's gateway contract says a gateway may consume
 * them "for routing, attribution, and tracing". Codex marks its traffic with an
 * `originator` header. This module turns those into attribution tags without any
 * `ATTRIBUTION_HEADERS` configuration, so the ledger, request log and audit roll up
 * by session, prompt, subagent and request class — and by agent product
 * (`agent: claude-code | codex`), which the FinOps chargeback view groups on.
 *
 * Values are bounded printable strings (the same rule as configured attribution
 * headers: they key budget counters and land in durable rows). The tool-duration
 * hint (up to 4 KB) is deliberately not captured.
 */
export interface AgentAttributionInput {
  headers: Record<string, string | string[] | undefined>;
}

/** Header → attribution key. Keys are stable names the FinOps views group on. */
export const CLAUDE_CODE_ATTRIBUTION_HEADERS: ReadonlyArray<
  readonly [header: string, key: string]
> = [
  ['x-claude-code-session-id', 'session'],
  ['x-claude-code-agent-id', 'cc_agent'],
  ['x-claude-code-parent-agent-id', 'cc_parent_agent'],
  ['x-claude-code-prompt-id', 'prompt'],
  ['x-claude-code-request-class', 'request_class'],
  ['x-claude-code-agent-type', 'agent_type'],
  ['x-claude-code-compaction', 'compaction'],
  ['x-claude-code-context-compacted', 'context_compacted'],
];

const VALUE_MAX_LEN = 128;
/** Printable ASCII only (the contract guarantees it for Claude Code's headers), and
 *  never `{`/`}` — they delimit a Redis hash-tag in `attr:<key>:<value>` counter keys. */
const VALUE_RE = /^[\x20-\x7a\x7c\x7e]{1,128}$/;

function value(raw: string | string[] | undefined): string | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' && v.length <= VALUE_MAX_LEN && VALUE_RE.test(v) ? v : undefined;
}

/** Which agent product sent the request, when it identifies itself. */
export function agentProduct(headers: AgentAttributionInput['headers']): string | undefined {
  const originator = value(headers['originator']);
  if (originator && /^codex/i.test(originator)) return 'codex';
  const ua = value(headers['user-agent']);
  if (ua && /^claude-cli\//i.test(ua)) return 'claude-code';
  if (ua && /codex/i.test(ua)) return 'codex';
  for (const [header] of CLAUDE_CODE_ATTRIBUTION_HEADERS) {
    if (headers[header] !== undefined) return 'claude-code';
  }
  return undefined;
}

/** Attribution tags derived from the agent's own headers. Returns undefined when the
 *  request carries none. Configured `ATTRIBUTION_HEADERS` tags (the operator's own
 *  mapping) take precedence over these when they share a key. */
export function agentAttribution(
  headers: AgentAttributionInput['headers'],
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [header, key] of CLAUDE_CODE_ATTRIBUTION_HEADERS) {
    const v = value(headers[header]);
    if (v !== undefined) out[key] = v;
  }
  const product = agentProduct(headers);
  if (product) out['agent'] = product;
  return Object.keys(out).length > 0 ? out : undefined;
}
