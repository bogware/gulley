/**
 * Static header modification — set or remove request/response headers by config,
 * the non-CEL sibling of the gateway's dynamic transformer. Names are compared
 * case-insensitively (HTTP headers are case-insensitive); `set` wins over
 * `remove` for the same name.
 */
export interface HeaderRules {
  set?: Record<string, string>;
  remove?: string[];
}

export interface HeaderModifierConfig {
  request?: HeaderRules;
  response?: HeaderRules;
}

/** Apply header rules in place to a header map (keys lower-cased). Returns the
 *  same object for chaining. */
export function applyHeaderRules<T extends Record<string, unknown>>(
  headers: T,
  rules: HeaderRules | undefined,
): T {
  if (!rules) return headers;
  for (const name of rules.remove ?? []) delete headers[name.toLowerCase()];
  for (const [name, value] of Object.entries(rules.set ?? {})) {
    (headers as Record<string, unknown>)[name.toLowerCase()] = value;
  }
  return headers;
}
