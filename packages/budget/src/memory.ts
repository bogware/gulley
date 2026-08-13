import type { Budget, BudgetDecision, BudgetStore } from './types';

interface Counters {
  reserved: Map<string, number>;
  reservedTotal: number;
  committed: number;
}

/**
 * In-memory budget store. Atomic by virtue of Node's single thread — the
 * reserve check + increment run with no `await` between them, so concurrent
 * reserves are serialized and a burst that would breach the cap is rejected.
 * The Redis store applies the same algorithm via Lua for cross-process safety.
 */
export class InMemoryBudgetStore implements BudgetStore {
  private readonly counters = new Map<string, Counters>();

  constructor(private readonly caps: Map<string, Budget>) {}

  private counter(ws: string): Counters {
    let c = this.counters.get(ws);
    if (!c) {
      c = { reserved: new Map(), reservedTotal: 0, committed: 0 };
      this.counters.set(ws, c);
    }
    return c;
  }

  async reserve(
    workspaceId: string,
    requestId: string,
    worstCaseMicroUsd: number,
  ): Promise<BudgetDecision | null> {
    const budget = this.caps.get(workspaceId);
    if (!budget) return null;

    const c = this.counter(workspaceId);
    const used = c.reservedTotal + c.committed;
    if (used + worstCaseMicroUsd > budget.capMicroUsd) {
      return { allowed: false, capMicroUsd: budget.capMicroUsd, usedMicroUsd: used };
    }
    c.reserved.set(requestId, worstCaseMicroUsd);
    c.reservedTotal += worstCaseMicroUsd;
    return {
      allowed: true,
      capMicroUsd: budget.capMicroUsd,
      usedMicroUsd: used + worstCaseMicroUsd,
    };
  }

  async commit(workspaceId: string, requestId: string, actualMicroUsd: number): Promise<void> {
    const c = this.counter(workspaceId);
    const reserved = c.reserved.get(requestId) ?? 0;
    c.reserved.delete(requestId);
    c.reservedTotal -= reserved;
    c.committed += actualMicroUsd;
  }

  /** Test/inspection helper. */
  committed(workspaceId: string): number {
    return this.counters.get(workspaceId)?.committed ?? 0;
  }
}
