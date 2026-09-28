import type { Budget, BudgetDecision, BudgetStore } from './types';

interface Counters {
  /** requestId → { worst-case amount, expiry }. The expiry lets an orphaned reservation
   *  (a request that crashed between reserve and commit) be swept instead of stranding its
   *  worst-case forever and permanently shrinking the cap — mirroring the Redis store. */
  reserved: Map<string, { amount: number; expiresAtMs: number }>;
  reservedTotal: number;
  committed: number;
  /** Start of the current fixed window (epoch ms); 0 = no spend yet / lifetime cap. */
  windowStartMs: number;
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
 * Periodic caps roll over exactly like the Redis store: a fixed window that starts at
 * the first committed spend and resets once `periodSeconds` have elapsed. (Previously
 * `periodSeconds` was ignored here, so every rolling cap — including the forced 24 h
 * window on attribution caps — became a lifetime cap on the no-Redis path.)
 */
export class InMemoryBudgetStore implements BudgetStore {
  private readonly counters = new Map<string, Counters>();
  private readonly capFor: (scope: string) => Budget | null;
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
    caps: Map<string, Budget> | ((scope: string) => Budget | null),
    private readonly now: () => number = () => Date.now(),
    /** Max lifetime of a reservation before it is swept as orphaned (ms); matches the
     *  Redis store's default so the two paths reclaim on the same horizon. */
    private readonly maxReservationLifetimeMs = 600_000,
  ) {
    this.capFor = typeof caps === 'function' ? caps : (scope) => caps.get(scope) ?? null;
  }

  private counter(ws: string): Counters {
    let c = this.counters.get(ws);
    if (!c) {
      c = {
        reserved: new Map(),
        reservedTotal: 0,
        committed: 0,
        windowStartMs: 0,
        lastTouchedMs: 0,
      };
      this.counters.set(ws, c);
    }
    return c;
  }

  /** Reset the committed counter when its fixed window has elapsed. */
  private rollWindow(c: Counters, budget: Budget | null, nowMs: number): void {
    if (!budget?.periodSeconds || c.windowStartMs === 0) return;
    if (nowMs - c.windowStartMs >= budget.periodSeconds * 1000) {
      c.committed = 0;
      c.windowStartMs = 0;
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
      // Only a scope whose window has lapsed (or that never spent) is released; the
      // forced 24 h window on attribution caps keeps client-controlled scopes bounded.
      this.rollWindow(c, budget, nowMs);
      if (c.committed === 0) this.counters.delete(k);
    }
  }

  async reserve(
    workspaceId: string,
    requestId: string,
    worstCaseMicroUsd: number,
  ): Promise<BudgetDecision | null> {
    const budget = this.capFor(workspaceId);
    if (!budget) return null;
    const nowMs = this.now();
    this.prune(nowMs);

    const c = this.counter(workspaceId);
    c.lastTouchedMs = nowMs;
    this.rollWindow(c, budget, nowMs);
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
    const used = c.reservedTotal + c.committed;
    if (used + worstCaseMicroUsd > budget.capMicroUsd) {
      return { allowed: false, capMicroUsd: budget.capMicroUsd, usedMicroUsd: used };
    }
    c.reserved.set(requestId, {
      amount: worstCaseMicroUsd,
      expiresAtMs: nowMs + this.maxReservationLifetimeMs,
    });
    c.reservedTotal += worstCaseMicroUsd;
    return {
      allowed: true,
      capMicroUsd: budget.capMicroUsd,
      usedMicroUsd: used + worstCaseMicroUsd,
    };
  }

  async commit(workspaceId: string, requestId: string, actualMicroUsd: number): Promise<void> {
    const c = this.counter(workspaceId);
    const nowMs = this.now();
    c.lastTouchedMs = nowMs;
    this.rollWindow(c, this.capFor(workspaceId), nowMs);
    const r = c.reserved.get(requestId);
    c.reserved.delete(requestId);
    if (r) c.reservedTotal = Math.max(0, c.reservedTotal - r.amount);
    if (actualMicroUsd > 0) {
      if (c.windowStartMs === 0) c.windowStartMs = nowMs; // fixed window from first spend
      c.committed += actualMicroUsd;
    }
  }

  /** Re-stamp a live reservation's expiry so a long stream isn't swept mid-flight (the
   *  in-memory analogue of the Redis refresh). No-op once the reservation is gone. */
  async refresh(workspaceId: string, requestId: string): Promise<void> {
    const r = this.counters.get(workspaceId)?.reserved.get(requestId);
    if (r) r.expiresAtMs = this.now() + this.maxReservationLifetimeMs;
  }

  /** Test/inspection helper. */
  committed(workspaceId: string): number {
    return this.counters.get(workspaceId)?.committed ?? 0;
  }

  /** Test/inspection helper: tracked scopes. */
  get size(): number {
    return this.counters.size;
  }
}
