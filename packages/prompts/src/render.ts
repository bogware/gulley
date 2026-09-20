/** `{{ name }}` placeholder — a single identifier, optional surrounding spaces. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** Distinct variable names referenced by a template body, in first-seen order
 *  then sorted for a stable declared set. */
export function extractVariables(body: string): string[] {
  const seen = new Set<string>();
  PLACEHOLDER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER.exec(body)) !== null) {
    if (m[1]) seen.add(m[1]);
  }
  return [...seen].sort();
}

export class MissingVariablesError extends Error {
  constructor(public readonly missing: string[]) {
    super(`missing variables: ${missing.join(', ')}`);
    this.name = 'MissingVariablesError';
  }
}

/** Substitute every `{{ name }}` with `vars[name]`. Strict: a placeholder with no
 *  provided value throws `MissingVariablesError` (a governed prompt must never
 *  silently ship a half-filled template). Values are stringified; extra vars are
 *  ignored. */
export function renderPrompt(body: string, vars: Record<string, unknown>): string {
  const missing: string[] = [];
  PLACEHOLDER.lastIndex = 0;
  const out = body.replace(PLACEHOLDER, (_full, name: string) => {
    // Own properties only: `{{constructor}}` must not resolve to Object.prototype.
    if (!Object.hasOwn(vars, name) || vars[name] === undefined || vars[name] === null) {
      missing.push(name);
      return '';
    }
    return String(vars[name]);
  });
  if (missing.length > 0) throw new MissingVariablesError([...new Set(missing)].sort());
  return out;
}
