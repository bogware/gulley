import type { AccessControl, AdminPrincipal } from '@gulley/rbac';
import type { DiffSummary } from './canonical';
import type { ConfigDocument } from './document';

export interface AppliedDiff {
  summary: DiffSummary;
}

export interface ReconcileContext {
  admin: AdminPrincipal;
  access: AccessControl;
}

/**
 * Maps the control-plane config to/from a ConfigDocument. Implemented by the
 * control-api over its stores (in-memory here, Postgres in prod). `reconcile`
 * upserts within authorized orgs and NEVER touches virtual keys.
 */
export interface ConfigStore {
  exportDocument(orgIds: ReadonlySet<string> | '*'): Promise<ConfigDocument>;
  /** May the admin apply every org affected by `desired`? (present ∪ removed) */
  authorize(desired: ConfigDocument, cx: ReconcileContext): Promise<boolean>;
  reconcile(desired: ConfigDocument, cx: ReconcileContext): Promise<AppliedDiff>;
}

export interface ConfigVersionRecord {
  version: number;
  contentHash: string;
  yaml: string;
  actor: string;
  summary: DiffSummary;
  auditSeq: number;
  createdAt: string;
}

export interface ConfigVersionStore {
  currentVersion(): Promise<number>;
  current(): Promise<ConfigVersionRecord | null>;
  /** Atomically bump the counter from `expected` to `expected+1`; returns the
   *  new version, or null on a lost race (optimistic concurrency). */
  tryReserve(expected: number): Promise<number | null>;
  append(rec: ConfigVersionRecord): Promise<void>;
}

export class InMemoryConfigVersionStore implements ConfigVersionStore {
  private counter = 0;
  private readonly records: ConfigVersionRecord[] = [];

  async currentVersion(): Promise<number> {
    return this.counter;
  }
  async current(): Promise<ConfigVersionRecord | null> {
    return this.records[this.records.length - 1] ?? null;
  }
  async tryReserve(expected: number): Promise<number | null> {
    if (this.counter !== expected) return null;
    this.counter += 1;
    return this.counter;
  }
  async append(rec: ConfigVersionRecord): Promise<void> {
    this.records.push(rec);
  }
}
