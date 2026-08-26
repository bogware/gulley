/**
 * DTOs for the Gulley admin console, mirroring the control-api responses this UI
 * consumes. Kept as a hand-authored mirror (not a shared package import) so the
 * web app stays a thin, independently buildable client.
 */

export type RequestStatus = 'ok' | 'error' | 'aborted';

export interface RequestLog {
  id: string;
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
  createdAt: string;
  attributes?: Record<string, unknown>;
}

export interface LogPage {
  entries: RequestLog[];
  nextCursor?: string;
}

export interface LogFilter {
  workspaceId?: string;
  provider?: string;
  model?: string;
  status?: RequestStatus;
  minStatusCode?: number;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export type UsageBucketWidth = 'minute' | 'hour' | 'day';

export interface UsageBucket {
  bucketStart: string;
  group?: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
}

export interface UsageQuery {
  workspaceId?: string;
  from?: string;
  to?: string;
  bucket?: UsageBucketWidth;
  groupBy?: 'provider' | 'model' | 'workspace';
}

export interface Org {
  id: string;
  name: string;
}
export interface Workspace {
  id: string;
  orgId: string;
  name: string;
}
export interface VirtualKeyView {
  id: string;
  keyPrefix: string;
  workspaceId: string;
  displayName: string;
  disabled: boolean;
}
export interface Provider {
  id: string;
  workspaceId: string;
  kind: string;
  baseUrl: string | null;
  enabled: boolean;
}

export interface CollectionEntity {
  id: string;
  workspaceId: string;
  name: string;
  config: Record<string, unknown>;
}

/** The workspace-scoped config collections exposed by the control-api. */
export type CollectionKind = 'budgets' | 'rate-limits' | 'guardrails' | 'routes' | 'policies';

/** Micro-USD → a display string like "$1.2345". */
export function formatUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(4)}`;
}
