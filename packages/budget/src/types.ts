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
  /** Optional: re-stamp a live reservation's expiry so a long-running stream is not
   *  reaped by the orphan-sweep (which reclaims reservations older than the max
   *  lifetime so a crashed request can't strand its worst-case forever). Called
   *  throttled while a stream is in flight. Backends without an expiry-based sweep
   *  (in-memory) may omit this. */
  refresh?(workspaceId: string, requestId: string): Promise<void>;
  /** Optional: rebuild a LOST committed counter from the durable ledger. The counters
   *  are "a rebuildable projection" of the ledger, but a counters-Redis flush resets
   *  committed to 0 and over-admits until the window rolls. Given the ledger sum over
   *  the active window, this rebuilds the counter ONLY when it is absent (flush
   *  recovery) — a live counter is authoritative for its fixed window and is never
   *  overwritten. Backends without a losable counter (in-memory) may omit this. */
  healCommitted?(
    workspaceId: string,
    ledgerMicroUsd: number,
    periodSeconds: number,
  ): Promise<{ healed: boolean; committedMicroUsd: number }>;
}

export type CapResolver = (workspaceId: string) => Promise<Budget | null>;
