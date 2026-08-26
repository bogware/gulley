/**
 * Request shaping — cheap, no-expression-engine policy applied to a parsed
 * request body before it is forwarded: field defaults (set only if absent),
 * field overrides (always win), and system-prompt enrichment. Enrichment targets
 * the Anthropic-canonical `system` field (string or array of text blocks);
 * OpenAI messages-embedded system enrichment is a later addition.
 */
export interface RequestShaping {
  /** Set each field only when it is absent from the request body. */
  defaults?: Record<string, unknown>;
  /** Force each field, overriding whatever the client sent. */
  overrides?: Record<string, unknown>;
  /** Prepend this text to the system prompt. */
  systemPrepend?: string;
  /** Append this text to the system prompt. */
  systemAppend?: string;
}

export function hasShaping(s: RequestShaping): boolean {
  return Boolean(
    (s.defaults && Object.keys(s.defaults).length) ||
    (s.overrides && Object.keys(s.overrides).length) ||
    s.systemPrepend ||
    s.systemAppend,
  );
}

export function shapeRequestBody(
  body: Record<string, unknown>,
  shaping: RequestShaping,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  if (shaping.defaults) {
    for (const [k, v] of Object.entries(shaping.defaults)) if (!(k in out)) out[k] = v;
  }
  if (shaping.overrides) {
    for (const [k, v] of Object.entries(shaping.overrides)) out[k] = v;
  }
  if (shaping.systemPrepend || shaping.systemAppend) {
    out['system'] = enrichSystem(out['system'], shaping.systemPrepend, shaping.systemAppend);
  }
  return out;
}

function enrichSystem(system: unknown, prepend?: string, append?: string): unknown {
  if (Array.isArray(system)) {
    const blocks = [...(system as unknown[])];
    if (prepend) blocks.unshift({ type: 'text', text: prepend });
    if (append) blocks.push({ type: 'text', text: append });
    return blocks;
  }
  const base = typeof system === 'string' ? system : '';
  return [prepend, base, append]
    .filter((s): s is string => Boolean(s && s.length > 0))
    .join('\n\n');
}
