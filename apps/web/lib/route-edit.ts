/** A weighted route target as the console edits it. */
export interface Target {
  name: string;
  provider?: string;
  weight: number;
}

/** Write the edited mode + weights back into the route's config at the same place
 *  parseRoute read them from (a nested `strategy` object, or the top level). */
export function applyRouteEdits(
  raw: Record<string, unknown>,
  mode: string,
  targets: Target[],
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw };
  const nested = next['strategy'] && typeof next['strategy'] === 'object';
  const holder: Record<string, unknown> = nested
    ? { ...(next['strategy'] as Record<string, unknown>) }
    : next;
  const existing = Array.isArray(holder['targets']) ? (holder['targets'] as unknown[]) : [];
  holder['mode'] = mode;
  if (existing.length > 0) {
    holder['targets'] = existing.map((t, i) => ({
      ...((t ?? {}) as Record<string, unknown>),
      weight: targets[i]?.weight ?? ((t ?? {}) as Record<string, unknown>)['weight'],
    }));
  }
  if (nested) next['strategy'] = holder;
  return next;
}
