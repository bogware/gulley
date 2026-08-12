import { createHash } from 'node:crypto';

export interface AuditEventInput {
  orgId?: string | null;
  actor: string;
  action: string;
  target?: string | null;
  payload?: Record<string, unknown>;
}

export interface AuditRow extends AuditEventInput {
  seq: number;
  prevHash: string | null;
  rowHash: string;
  createdAt: Date;
}

/** Stable-key-order JSON so a row hashes identically on write and on verify. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) out[key] = sortKeys(input[key]);
    return out;
  }
  return value;
}

/** row_hash = H(prev_hash ‖ canonical(content)). A tamper-evident chain. */
export function computeRowHash(prevHash: string | null, content: unknown): string {
  return createHash('sha256')
    .update(prevHash ?? '')
    .update('\n')
    .update(canonicalize(content))
    .digest('hex');
}

/** The canonical content that gets hashed for a row. */
export function rowContent(row: {
  seq: number;
  orgId?: string | null;
  actor: string;
  action: string;
  target?: string | null;
  payload?: Record<string, unknown>;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    seq: row.seq,
    orgId: row.orgId ?? null,
    actor: row.actor,
    action: row.action,
    target: row.target ?? null,
    payload: row.payload ?? {},
    createdAt: row.createdAt.toISOString(),
  };
}

export interface AuditSink {
  append(event: AuditEventInput): Promise<AuditRow>;
}
