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
  /** Open, low-cardinality facet bag (cache status, guardrail action, virtual-key
   *  prefix, custom tags…) for filtering/faceting without a schema change. */
  attributes?: Record<string, unknown>;
}

export interface RequestLogSink {
  write(entry: RequestLogEntry): Promise<void>;
  /** Optional bulk path used by the batching writer; falls back to per-entry write. */
  writeBatch?(entries: RequestLogEntry[]): Promise<void>;
}

// --- Query side: an admin log browser + spend/usage analytics over request_log ---

export interface StoredRequestLog extends RequestLogEntry {
  /** Durable row id (distinct from the client-facing requestId). */
  id: string;
}

export interface RequestLogFilter {
  /** Restrict to these workspaces (RBAC scope). Empty/undefined = all. */
  workspaceIds?: readonly string[];
  provider?: string;
  model?: string;
  status?: RequestStatus;
  /** Only entries with statusCode ≥ this (e.g. 400 for errors-only). */
  minStatusCode?: number;
  from?: Date;
  to?: Date;
  /** Page size (default 50, capped by the store). */
  limit?: number;
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  cursor?: string;
}

export interface RequestLogPage {
  entries: StoredRequestLog[];
  /** Present when more rows remain; pass back as `cursor`. */
  nextCursor?: string;
}

export type UsageBucketWidth = 'minute' | 'hour' | 'day';

export interface UsageQuery {
  workspaceIds?: readonly string[];
  from: Date;
  to: Date;
  bucket: UsageBucketWidth;
  /** Split each time bucket by this dimension. */
  groupBy?: 'provider' | 'model' | 'workspace';
}

export interface UsageBucket {
  /** ISO timestamp of the bucket start. */
  bucketStart: string;
  /** The groupBy value, when a split was requested. */
  group?: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  /** Fraction (0..1) of the bucket's requests with statusCode ≥ 400. */
  errorRate: number;
  /** p95 of latencyMs across the bucket's requests (0 when empty). */
  p95LatencyMs: number;
}

/** Read side of the request log: a filtered/paginated browser plus time-bucketed
 *  usage rollups. The batched writer is the write side; this is eventually
 *  consistent with it (the durable spend ledger stays synchronous). */
export interface RequestLogQuery {
  search(filter: RequestLogFilter): Promise<RequestLogPage>;
  get(requestId: string): Promise<StoredRequestLog | null>;
  usage(query: UsageQuery): Promise<UsageBucket[]>;
}

/** Encode/decode the (createdAt, id) keyset cursor as opaque base64. */
export function encodeLogCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id]), 'utf8').toString('base64url');
}

export function decodeLogCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const [iso, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [
      string,
      string,
    ];
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime()) || typeof id !== 'string') return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
