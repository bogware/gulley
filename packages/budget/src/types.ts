export interface Budget {
  capMicroUsd: number;
  /** Rolling-window length; omit for a lifetime cap. */
  periodSeconds?: number;
}

export interface BudgetDecision {
  allowed: boolean;
  capMicroUsd: number;
  /** reserved + committed after this call. */
  usedMicroUsd: number;
}

/**
 * Hard budget enforcement via reserve/commit. At admission the worst-case cost
 * is RESERVED (rejecting if it would breach the cap — TOCTOU-safe under
 * concurrency); at completion the reservation is replaced by the ACTUAL spend,
 * refunding the difference. The Postgres ledger is the durable source of truth;
 * these counters are a rebuildable projection.
 */
export interface BudgetStore {
  /** Returns null when the workspace has no budget (no enforcement). Otherwise a
   *  decision; when `allowed` is false, nothing was reserved. */
  reserve(
    workspaceId: string,
    requestId: string,
    worstCaseMicroUsd: number,
  ): Promise<BudgetDecision | null>;
  commit(workspaceId: string, requestId: string, actualMicroUsd: number): Promise<void>;
}

export type CapResolver = (workspaceId: string) => Promise<Budget | null>;
