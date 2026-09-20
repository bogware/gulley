import { type AuthzRuleConfig, CelAuthorizer } from '@gulley/cel';
import { SSEParser } from '@gulley/providers';

/**
 * LLM-leg tool-call intent governance — WITHOUT an MCP proxy.
 *
 * When the model's RESPONSE asks the client to call a tool (an Anthropic `tool_use`
 * block, an OpenAI chat `tool_calls[]` entry, or an OpenAI Responses `function_call`
 * item), Gulley evaluates that intent against a CEL policy BEFORE the client ever
 * executes it. A deny withholds the whole response (fail-closed), so a prompt-
 * injected or out-of-policy tool call (`rm -rf`, a write outside an allowed path, a
 * disallowed tool) never reaches the client's executor. This governs the model's
 * REQUEST to act, not the tool's execution, so no MCP interception is needed.
 *
 * The policy reuses @gulley/cel's deny-first CelAuthorizer over a per-call
 * activation `{ tool: { name, input }, model, provider, principal }`.
 */

export interface ToolCall {
  name: string;
  /** The tool arguments as a parsed object when possible (so a CEL policy can read
   *  `tool.input.command` etc.), else the raw value/string. */
  input: unknown;
  id?: string;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Best-effort parse of a tool-argument payload: a JSON string becomes its object,
 *  anything else is returned as-is. Never throws (a policy over an unparsed string
 *  still matches on the raw value). */
function parseArgs(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * Extract the tool calls a model response is asking the client to make, across the
 * three response dialects. Returns [] when the body carries no tool call (a normal
 * text answer) or isn't one of the known shapes.
 */
export function extractToolCalls(body: unknown): ToolCall[] {
  const b = asRecord(body);
  if (!b) return [];
  const calls: ToolCall[] = [];

  // Anthropic Messages: content[] with tool_use blocks.
  if (Array.isArray(b['content'])) {
    for (const blk of b['content']) {
      const r = asRecord(blk);
      if (r && r['type'] === 'tool_use' && typeof r['name'] === 'string') {
        calls.push({ name: r['name'], input: r['input'] ?? {}, id: strOrUndef(r['id']) });
      }
    }
  }

  // OpenAI chat.completions: choices[].message.tool_calls[].function{name,arguments}.
  if (Array.isArray(b['choices'])) {
    for (const ch of b['choices']) {
      const msg = asRecord(asRecord(ch)?.['message']);
      const tcs = msg?.['tool_calls'];
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const fn = asRecord(asRecord(tc)?.['function']);
          if (fn && typeof fn['name'] === 'string') {
            calls.push({
              name: fn['name'],
              input: parseArgs(fn['arguments']),
              id: strOrUndef(asRecord(tc)?.['id']),
            });
          }
        }
      }
    }
  }

  // OpenAI Responses: output[] with function_call items {name, arguments, call_id}.
  if (Array.isArray(b['output'])) {
    for (const item of b['output']) {
      const r = asRecord(item);
      if (r && r['type'] === 'function_call' && typeof r['name'] === 'string') {
        calls.push({
          name: r['name'],
          input: parseArgs(r['arguments']),
          id: strOrUndef(r['call_id']),
        });
      }
    }
  }

  return calls;
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export type ToolStreamDialect = 'anthropic' | 'openai' | 'responses';

/**
 * Reassemble the tool calls from a BUFFERED streamed response so a streamed tool
 * call is governed exactly like a non-streamed one (no `stream:true` bypass). Tool
 * arguments arrive incrementally (Anthropic `input_json_delta`, OpenAI chat
 * `tool_calls[].function.arguments` deltas, OpenAI Responses
 * `function_call_arguments.delta`), so we accumulate them per call and parse once.
 * Best-effort + never throws: an unparseable argument stream still surfaces the
 * call (with its raw string input) so a name-based deny still fires.
 */
export function extractToolCallsFromSse(sse: string, dialect: ToolStreamDialect): ToolCall[] {
  const parser = new SSEParser();
  const events = [...parser.push(sse), ...parser.push('\n\n')]; // flush a trailing event
  const parsed = events.map((e) => {
    let data: unknown;
    try {
      data = JSON.parse(e.data);
    } catch {
      data = undefined;
    }
    return { event: e.event, data: asRecord(data) };
  });
  if (dialect === 'anthropic') return fromAnthropicSse(parsed);
  if (dialect === 'responses') return fromResponsesSse(parsed);
  return fromOpenAiChatSse(parsed);
}

interface ParsedEvent {
  event?: string;
  data: Record<string, unknown> | undefined;
}

/**
 * The LOGICAL text of a streamed response (every text/thinking/tool-argument delta
 * joined, per client dialect) — what an output guardrail must inspect. Scanning the
 * raw SSE framing instead lets a value split across two delta events (or JSON-escaped
 * inside a frame) through undetected.
 */
export function extractTextFromSse(sse: string, dialect: ToolStreamDialect): string {
  const parser = new SSEParser({ onOverflow: 'reset' });
  const events = [...parser.push(sse), ...parser.push('\n\n')];
  const parts: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.length > 0) parts.push(v);
  };
  for (const e of events) {
    let data: Record<string, unknown> | undefined;
    try {
      data = asRecord(JSON.parse(e.data));
    } catch {
      continue;
    }
    if (!data) continue;
    if (dialect === 'anthropic') {
      // The event type may ride on the `event:` line only (some upstreams omit it
      // from the JSON), so accept either.
      const type = typeof data['type'] === 'string' ? data['type'] : e.event;
      if (type !== 'content_block_delta') continue;
      const delta = asRecord(data['delta']);
      push(delta?.['text']);
      push(delta?.['partial_json']);
      push(delta?.['thinking']);
    } else if (dialect === 'responses') {
      const type = typeof data['type'] === 'string' ? (data['type'] as string) : e.event;
      if (
        type === 'response.output_text.delta' ||
        type === 'response.function_call_arguments.delta' ||
        type === 'response.reasoning_summary_text.delta'
      )
        push(data['delta']);
    } else {
      const choices = data['choices'];
      const delta = Array.isArray(choices) ? asRecord(asRecord(choices[0])?.['delta']) : undefined;
      push(delta?.['content']);
      push(delta?.['reasoning_content']);
      const tcs = delta?.['tool_calls'];
      if (Array.isArray(tcs))
        for (const raw of tcs) push(asRecord(asRecord(raw)?.['function'])?.['arguments']);
    }
  }
  return parts.join('');
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function fromAnthropicSse(events: ParsedEvent[]): ToolCall[] {
  const byIndex = new Map<number, { id?: string; name: string; json: string }>();
  const order: number[] = [];
  for (const { data } of events) {
    if (!data) continue;
    const type = data['type'];
    if (type === 'content_block_start') {
      const cb = asRecord(data['content_block']);
      const idx = num(data['index']);
      if (cb && cb['type'] === 'tool_use' && typeof cb['name'] === 'string' && idx !== undefined) {
        byIndex.set(idx, { id: strOrUndef(cb['id']), name: cb['name'], json: '' });
        order.push(idx);
      }
    } else if (type === 'content_block_delta') {
      const delta = asRecord(data['delta']);
      const idx = num(data['index']);
      if (
        delta &&
        delta['type'] === 'input_json_delta' &&
        typeof delta['partial_json'] === 'string'
      ) {
        const cur = idx !== undefined ? byIndex.get(idx) : undefined;
        if (cur) cur.json += delta['partial_json'];
      }
    }
  }
  return order.map((i) => {
    const c = byIndex.get(i)!;
    return { name: c.name, input: parseArgs(c.json.length ? c.json : '{}'), id: c.id };
  });
}

function fromOpenAiChatSse(events: ParsedEvent[]): ToolCall[] {
  const byIndex = new Map<number, { id?: string; name: string; args: string }>();
  const order: number[] = [];
  for (const { data } of events) {
    if (!data) continue;
    const choices = data['choices'];
    const delta = Array.isArray(choices) ? asRecord(asRecord(choices[0])?.['delta']) : undefined;
    const tcs = delta?.['tool_calls'];
    if (!Array.isArray(tcs)) continue;
    for (const raw of tcs) {
      const tc = asRecord(raw);
      if (!tc) continue;
      const idx = num(tc['index']) ?? 0;
      let cur = byIndex.get(idx);
      if (!cur) {
        cur = { id: strOrUndef(tc['id']), name: '', args: '' };
        byIndex.set(idx, cur);
        order.push(idx);
      }
      if (typeof tc['id'] === 'string' && !cur.id) cur.id = tc['id'];
      const fn = asRecord(tc['function']);
      if (fn) {
        if (typeof fn['name'] === 'string') cur.name += fn['name'];
        if (typeof fn['arguments'] === 'string') cur.args += fn['arguments'];
      }
    }
  }
  return order
    .map((i) => {
      const c = byIndex.get(i)!;
      return { name: c.name, input: parseArgs(c.args.length ? c.args : '{}'), id: c.id };
    })
    .filter((c) => c.name.length > 0);
}

function fromResponsesSse(events: ParsedEvent[]): ToolCall[] {
  const byId = new Map<string, { callId?: string; name: string; args: string }>();
  const order: string[] = [];
  for (const { event, data } of events) {
    if (!data) continue;
    const type = typeof data['type'] === 'string' ? (data['type'] as string) : event;
    if (type === 'response.output_item.added') {
      const item = asRecord(data['item']);
      if (item && item['type'] === 'function_call' && typeof item['name'] === 'string') {
        const id = strOrUndef(item['id']) ?? strOrUndef(item['call_id']) ?? String(order.length);
        byId.set(id, {
          callId: strOrUndef(item['call_id']),
          name: item['name'],
          args: typeof item['arguments'] === 'string' ? (item['arguments'] as string) : '',
        });
        order.push(id);
      }
    } else if (type === 'response.function_call_arguments.delta') {
      if (typeof data['delta'] === 'string') {
        const id = strOrUndef(data['item_id']) ?? order[order.length - 1];
        const cur = id ? byId.get(id) : undefined;
        if (cur) cur.args += data['delta'];
      }
    }
  }
  return order.map((id) => {
    const c = byId.get(id)!;
    return { name: c.name, input: parseArgs(c.args.length ? c.args : '{}'), id: c.callId };
  });
}

export interface ToolActivationContext {
  model: string;
  provider: string;
  principal: { id: string; orgId: string; workspaceId: string };
}

/** The CEL activation a tool policy evaluates against — one per tool call. */
export function buildToolActivation(
  call: ToolCall,
  ctx: ToolActivationContext,
): Record<string, unknown> {
  return {
    tool: { name: call.name, input: call.input },
    model: ctx.model,
    provider: ctx.provider,
    principal: ctx.principal,
  };
}

export interface ToolGovernanceResult {
  /** The first denied call and the rule that denied it, or undefined if all allowed. */
  denied?: { call: ToolCall; reason: string };
  /** How many tool calls were evaluated. */
  evaluated: number;
}

/**
 * Evaluate every tool call in a response against the policy. Deny-first: the first
 * call any deny rule matches (or that an allow-list rejects) fails the whole
 * response. A response with no tool calls is trivially allowed.
 */
export function governToolCalls(
  policy: CelAuthorizer,
  calls: ToolCall[],
  ctx: ToolActivationContext,
): ToolGovernanceResult {
  for (const call of calls) {
    const decision = policy.authorize(buildToolActivation(call, ctx));
    if (!decision.allowed) {
      return {
        denied: { call, reason: decision.reason ?? 'tool call denied' },
        evaluated: calls.length,
      };
    }
  }
  return { evaluated: calls.length };
}

/** Build the tool policy from `TOOL_POLICY` (a JSON array of CEL rules, same shape
 *  as the request AUTHZ rules). Returns undefined when unset/empty. Invalid JSON or
 *  a bad rule THROWS (a malformed governance policy must fail boot, never silently
 *  disable governance). */
export function parseToolPolicy(raw: string | undefined): CelAuthorizer | undefined {
  if (!raw || raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('TOOL_POLICY is not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('TOOL_POLICY must be a JSON array of CEL rules');
  const rules: AuthzRuleConfig[] = [];
  for (const r of parsed) {
    const o = asRecord(r);
    if (
      !o ||
      typeof o['expr'] !== 'string' ||
      (o['effect'] !== 'allow' && o['effect'] !== 'deny')
    ) {
      throw new Error(
        'TOOL_POLICY rule must be { expr: string, effect: "allow"|"deny", name?: string }',
      );
    }
    rules.push({
      expr: o['expr'],
      effect: o['effect'],
      ...(typeof o['name'] === 'string' ? { name: o['name'] } : {}),
    });
  }
  // Compiling here surfaces a bad CEL expression at boot (fail-closed).
  return new CelAuthorizer(rules);
}
