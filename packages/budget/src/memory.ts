import {
  type BudgetDecision,
  type BudgetLike,
  type BudgetSpec,
  type BudgetStore,
  type BudgetWindow,
  normalizeBudget,
} from './types';
import { type BudgetPeriod, isCalendar, windowEnd, windowId } from './window';

interface WindowCounter {
  committed: number;
  /** Start of the current FIXED window (epoch ms); 0 = no spend yet / lifetime cap. */
  windowStartMs: number;
}

interface Counters {
  /** requestId → { worst-case amount, expiry }. The expiry lets an orphaned reservation
   *  (a request that crashed between reserve and commit) be swept instead of stranding its
   *  worst-case forever and permanently shrinking the cap — mirroring the Redis store. */
  reserved: Map<string, { amount: number; expiresAtMs: number }>;
  reservedTotal: number;
  /** Committed spend per window id (`none` / `f:<s>` / `d:…` / `w:…` / `m:…`). */
  windows: Map<string, WindowCounter>;
  lastTouchedMs: number;
}

/** Idle scopes are dropped after this long with no reservation activity, bounding the
 *  map on the counter-less path (attr:<key>:<value> scopes are client-controlled) — but
 *  only once they hold no live committed spend (see prune). */
const IDLE_PRUNE_MS = 24 * 60 * 60 * 1000;
const PRUNE_EVERY_N_RESERVES = 1_000;

/**
 * In-memory budget store. Atomic by virtue of Node's single thread — the
 * reserve check + increment run with no `await` between them, so concurrent
 * reserves are serialized and a burst that would breach the cap is rejected.
 * The Redis store applies the same algorithm via Lua for cross-process safety.
 *
 * Windows roll over exactly like the Redis store: a FIXED window starts at the first
 * committed spend and resets once its seconds have elapsed; a CALENDAR window is a
 * separate counter per window id, so the next day/week/month is simply a new, empty
 * counter. Every window of a budget must admit.
 */
export class InMemoryBudgetStore implements BudgetStore {
  private readonly counters = new Map<string, Counters>();
  private readonly capFor: (scope: string) => BudgetLike | null;
  private reserves = 0;

  /**
   * Accepts either a static `scope → Budget` map or a resolver function. A
   * resolver lets dynamically-keyed scopes (e.g. `attr:<key>:<value>`, whose
   * value isn't known at boot) enforce on the counter-less path exactly as they
   * do against Redis — otherwise a config-sourced cap would silently fall through
   * to null (no enforcement) here while enforcing under Redis. The resolver stays
   * synchronous so the reserve check + increment remain a single atomic step.
   */
  constructor(
    caps: Map<string, BudgetLike> | ((scope: string) => BudgetLike | null),
    private readonly now: () => number = () => Date.now(),
    /** Max lifetime of a reservation before it is swept as orphaned (ms); matches the
     *  Redis store's default so the two paths reclaim on the same horizon. */
    private readonly maxReservationLifetimeMs = 600_000,
  ) {
    this.capFor = typeof caps === 'function' ? caps : (scope) => caps.get(scope) ?? null;
  }

  private counter(scope: string): Counters {
    let c = this.counters.get(scope);
    if (!c) {
      c = { reserved: new Map(), reservedTotal: 0, windows: new Map(), lastTouchedMs: 0 };
      this.counters.set(scope, c);
    }
    return c;
  }

  private windowCounter(c: Counters, w: BudgetWindow, nowMs: number): WindowCounter {
    const id = windowId(w.period, nowMs);
    let wc = c.windows.get(id);
    if (!wc) {
      wc = { committed: 0, windowStartMs: 0 };
      c.windows.set(id, wc);
    }
    // A FIXED window resets once its seconds have elapsed since the first spend.
    if (w.period.kind === 'fixed' && wc.windowStartMs !== 0) {
      if (nowMs - wc.windowStartMs >= w.period.seconds * 1000) {
        wc.committed = 0;
        wc.windowStartMs = 0;
      }
    }
    return wc;
  }

  /** Drop calendar-window counters that can no longer be current (bounded growth). */
  private dropStaleWindows(c: Counters, spec: BudgetSpec, nowMs: number): void {
    const live = new Set(spec.windows.map((w) => windowId(w.period, nowMs)));
    for (const id of c.windows.keys()) {
      if (!live.has(id) && id !== 'none' && !id.startsWith('f:')) c.windows.delete(id);
    }
  }

  private prune(nowMs: number): void {
    if (++this.reserves % PRUNE_EVERY_N_RESERVES !== 0) return;
    for (const [k, c] of this.counters) {
      if (c.reserved.size > 0 || nowMs - c.lastTouchedMs <= IDLE_PRUNE_MS) continue;
      const budget = this.capFor(k);
      if (!budget) {
        this.counters.delete(k); // no cap any more → nothing to enforce against
        continue;
      }
      // An idle scope still holding LIVE committed spend — a lifetime cap, or a window
      // longer than the idle horizon — must survive: dropping it silently reset the cap
      // to $0 spent (a lifetime cap could be breached again and again, once per day).
      // Only a scope whose windows have lapsed (or that never spent) is released; the
      // forced 24 h window on attribution caps keeps client-controlled scopes bounded.
      const spec = normalizeBudget(budget);
      this.dropStaleWindows(c, spec, nowMs);
      let live = 0;
      for (const w of spec.windows) live += this.windowCounter(c, w, nowMs).committed;
      if (live === 0) this.counters.delete(k);
    }
  }

  async reserve(
    scope: string,
    requestId: string,
    worstCaseMicroUsd: number,
  ): Promise<BudgetDecision | null> {
    const budget = this.capFor(scope);
    if (!budget) return null;
    const spec = normalizeBudget(budget);
    const nowMs = this.now();
    this.prune(nowMs);

    const c = this.counter(scope);
    c.lastTouchedMs = nowMs;
    this.dropStaleWindows(c, spec, nowMs);
    // Sweep this scope's orphaned reservations (a request that crashed between reserve and
    // commit) so their worst-case doesn't strand forever and shrink the cap — the in-memory
    // analogue of the Redis lifetime sweep. A live long stream refreshes its expiry (see
    // refresh), so it is never reaped mid-flight.
    for (const [id, r] of c.reserved) {
      if (r.expiresAtMs <= nowMs) {
        c.reserved.delete(id);
        c.reservedTotal = Math.max(0, c.reservedTotal - r.amount);
      }
    }
    // Every window must admit; report the binding one (highest utilization).
    let binding: { w: BudgetWindow; used: number } | undefined;
    for (const w of spec.windows) {
      const used = c.reservedTotal + this.windowCounter(c, w, nowMs).committed;
      if (used + worstCaseMicroUsd > w.capMicroUsd) {
        return {
          allowed: false,
          capMicroUsd: w.capMicroUsd,
          usedMicroUsd: used,
          window: windowInfo(w.period, nowMs),
        };
      }
      const after = used + worstCaseMicroUsd;
      if (!binding || after / w.capMicroUsd > binding.used / binding.w.capMicroUsd) {
        binding = { w, used: after };
      }
    }
    c.reserved.set(requestId, {
      amount: worstCaseMicroUsd,
      expiresAtMs: nowMs + this.maxReservationLifetimeMs,
    });
    c.reservedTotal += worstCaseMicroUsd;
    const b = binding as { w: BudgetWindow; used: number };
    return {
      allowed: true,
      capMicroUsd: b.w.capMicroUsd,
      usedMicroUsd: b.used,
      window: windowInfo(b.w.period, nowMs),
    };
  }

  async commit(scope: string, requestId: string, actualMicroUsd: number): Promise<void> {
    const c = this.counter(scope);
    const nowMs = this.now();
    c.lastTouchedMs = nowMs;
    const r = c.reserved.get(requestId);
    c.reserved.delete(requestId);
    if (r) c.reservedTotal = Math.max(0, c.reservedTotal - r.amount);
    if (actualMicroUsd > 0) {
      const budget = this.capFor(scope);
      const spec = budget ? normalizeBudget(budget) : { windows: [] };
      // No budget any more (cap removed mid-flight): nothing to count against.
      for (const w of spec.windows) {
        const wc = this.windowCounter(c, w, nowMs);
        if (w.period.kind === 'fixed' && wc.windowStartMs === 0) wc.windowStartMs = nowMs; // fixed window from first spend
        wc.committed += actualMicroUsd;
      }
    }
  }

  /** Re-stamp a live reservation's expiry so a long stream isn't swept mid-flight (the
   *  in-memory analogue of the Redis refresh). No-op once the reservation is gone. */
  async refresh(scope: string, requestId: string): Promise<void> {
    const r = this.counters.get(scope)?.reserved.get(requestId);
    if (r) r.expiresAtMs = this.now() + this.maxReservationLifetimeMs;
  }

  /** Test/inspection helper: committed spend in the current window of the FIRST
   *  configured window (or the lifetime/fixed counter when no budget is configured). */
  committed(scope: string, period?: BudgetPeriod): number {
    const c = this.counters.get(scope);
    if (!c) return 0;
    const nowMs = this.now();
    const p =
      period ??
      (() => {
        const b = this.capFor(scope);
        return b ? normalizeBudget(b).windows[0]?.period : undefined;
      })();
    if (!p) {
      // No budget known: sum whatever counters exist (legacy callers).
      let sum = 0;
      for (const w of c.windows.values()) sum += w.committed;
      return sum;
    }
    return c.windows.get(windowId(p, nowMs))?.committed ?? 0;
  }

  /** Test/inspection helper: tracked scopes. */
  get size(): number {
    return this.counters.size;
  }
}

function windowInfo(period: BudgetPeriod, nowMs: number): BudgetDecision['window'] {
  return isCalendar(period) ? { period, resetsAtMs: windowEnd(period, nowMs) } : { period };
}
