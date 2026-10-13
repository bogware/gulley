/**
 * Budget windows. A cap applies over one of:
 *  - `none`     — a lifetime cap that never resets;
 *  - `fixed`    — a window of `seconds` that starts at the first spend (the pre-0.7
 *                 `periodSeconds` semantics, kept for existing budgets);
 *  - `daily` / `weekly` / `monthly` — CALENDAR-aligned windows in UTC that reset at
 *                 midnight, Monday 00:00 and the 1st 00:00 respectively (the shape
 *                 every FinOps tool and invoice expects).
 *
 * A calendar window is identified by a stable id (`d:2026-10-11`, `w:2026-W41`,
 * `m:2026-10`); each id gets its own counter, so a reset is simply the next id.
 */
export type BudgetPeriod =
  | { kind: 'none' }
  | { kind: 'fixed'; seconds: number }
  | { kind: 'daily' }
  | { kind: 'weekly' }
  | { kind: 'monthly' };

export type CalendarPeriodKind = 'daily' | 'weekly' | 'monthly';

export function isCalendar(p: BudgetPeriod): p is { kind: CalendarPeriodKind } {
  return p.kind === 'daily' || p.kind === 'weekly' || p.kind === 'monthly';
}

const DAY_MS = 86_400_000;

/** Monday-based ISO week number and year for a UTC instant. */
function isoWeek(d: Date): { year: number; week: number } {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; // Sunday → 7
  t.setUTCDate(t.getUTCDate() + 4 - day); // nearest Thursday decides the week-year
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / DAY_MS + 1) / 7);
  return { year: t.getUTCFullYear(), week };
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** The stable id of the calendar window containing `nowMs`. */
export function windowId(period: BudgetPeriod, nowMs: number): string {
  const d = new Date(nowMs);
  switch (period.kind) {
    case 'daily':
      return `d:${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    case 'weekly': {
      const { year, week } = isoWeek(d);
      return `w:${year}-W${pad(week)}`;
    }
    case 'monthly':
      return `m:${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
    case 'fixed':
      return `f:${period.seconds}`;
    case 'none':
      return 'none';
  }
}

/** Start of the calendar window containing `nowMs` (epoch ms). */
export function windowStart(period: { kind: CalendarPeriodKind }, nowMs: number): number {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  switch (period.kind) {
    case 'daily':
      return Date.UTC(y, m, day);
    case 'weekly': {
      const dow = d.getUTCDay() || 7; // Monday = 1 … Sunday = 7
      return Date.UTC(y, m, day) - (dow - 1) * DAY_MS;
    }
    case 'monthly':
      return Date.UTC(y, m, 1);
  }
}

/** End (exclusive) of the calendar window containing `nowMs` — the reset instant. */
export function windowEnd(period: { kind: CalendarPeriodKind }, nowMs: number): number {
  const start = windowStart(period, nowMs);
  const d = new Date(start);
  switch (period.kind) {
    case 'daily':
      return start + DAY_MS;
    case 'weekly':
      return start + 7 * DAY_MS;
    case 'monthly':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
}

/** Whole seconds until the window containing `nowMs` resets (≥ 1). */
export function secondsUntilReset(period: { kind: CalendarPeriodKind }, nowMs: number): number {
  return Math.max(1, Math.ceil((windowEnd(period, nowMs) - nowMs) / 1000));
}

/** A human label for messages and alerts. */
export function periodLabel(period: BudgetPeriod): string {
  switch (period.kind) {
    case 'none':
      return 'lifetime';
    case 'fixed':
      return `${period.seconds}s window`;
    case 'daily':
      return 'daily';
    case 'weekly':
      return 'weekly';
    case 'monthly':
      return 'monthly';
  }
}

/** Parse the period vocabulary used in config: `none`, `daily`, `weekly`, `monthly`,
 *  `{ seconds }`, or a bare number of seconds (legacy `periodSeconds`). */
export function parsePeriod(v: unknown): BudgetPeriod | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') {
    return Number.isFinite(v) && v > 0 ? { kind: 'fixed', seconds: Math.floor(v) } : undefined;
  }
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'none' || s === 'lifetime') return { kind: 'none' };
    if (s === 'daily' || s === 'weekly' || s === 'monthly') return { kind: s };
    const m = /^(\d+)(s|m|h|d)$/.exec(s);
    if (m) {
      const n = Number(m[1]);
      const mult = { s: 1, m: 60, h: 3600, d: 86_400 }[m[2] as 's' | 'm' | 'h' | 'd'];
      return n > 0 ? { kind: 'fixed', seconds: n * mult } : undefined;
    }
    return undefined;
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o['kind'] === 'none') return { kind: 'none' };
    if (o['kind'] === 'daily' || o['kind'] === 'weekly' || o['kind'] === 'monthly') {
      return { kind: o['kind'] };
    }
    const seconds = o['seconds'] ?? (o['kind'] === 'fixed' ? o['seconds'] : undefined);
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
      return { kind: 'fixed', seconds: Math.floor(seconds) };
    }
  }
  return undefined;
}
