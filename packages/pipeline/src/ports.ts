import type { CostBreakdown } from '@gulley/cost';

export type RequestStatus = 'ok' | 'error' | 'aborted';

/** A durable spend entry. The Postgres ledger is the source of truth; Redis
 *  counters are a rebuildable projection of it. */
export interface SpendRecord {
  requestId: string;
  principalId: string;
  orgId: string;
  workspaceId: string;
  provider: string;
  model: string;
  cost: CostBreakdown;
  costMicroUsd: number;
  status: RequestStatus;
  createdAt: Date;
}

export interface Ledger {
  record(entry: SpendRecord): Promise<void>;
}

export interface RequestLogEntry {
  requestId: string;
  principalId: string;
  workspaceId: string;
  provider: string;
  model: string;
  route: string;
  statusCode: number;
  status: RequestStatus;
  streamed: boolean;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  latencyMs: number;
  createdAt: Date;
}

export interface RequestLogSink {
  write(entry: RequestLogEntry): Promise<void>;
}
