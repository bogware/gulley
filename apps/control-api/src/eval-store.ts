import type { EvalSuite, RolloutReport, RolloutTarget, RolloutThresholds } from './eval-rollout';

export type RolloutStatus = 'pending' | 'promoted' | 'held' | 'error';

/** A registered rollout and its latest run outcome. */
export interface StoredRollout {
  id: string;
  suiteId: string;
  target: RolloutTarget;
  thresholds: RolloutThresholds;
  status: RolloutStatus;
  createdAt: string;
  decidedAt?: string;
  /** Config version produced when a promote applied (durable-mode only). */
  appliedVersion?: number;
  report?: RolloutReport;
  error?: string;
}

/**
 * In-memory registry of eval suites + rollouts. Definitions live here (like the other
 * v1 admin resource stores); the DURABLE record of a rollout is the hash-chained audit
 * event it appends and — on promote — the config version it produces.
 */
export interface EvalStore {
  putSuite(s: EvalSuite): void;
  getSuite(id: string): EvalSuite | undefined;
  listSuites(): EvalSuite[];
  deleteSuite(id: string): boolean;
  putRollout(r: StoredRollout): void;
  getRollout(id: string): StoredRollout | undefined;
  listRollouts(): StoredRollout[];
}

export class InMemoryEvalStore implements EvalStore {
  private readonly suites = new Map<string, EvalSuite>();
  private readonly rollouts = new Map<string, StoredRollout>();

  putSuite(s: EvalSuite): void {
    this.suites.set(s.id, s);
  }
  getSuite(id: string): EvalSuite | undefined {
    return this.suites.get(id);
  }
  listSuites(): EvalSuite[] {
    return [...this.suites.values()];
  }
  deleteSuite(id: string): boolean {
    return this.suites.delete(id);
  }
  putRollout(r: StoredRollout): void {
    this.rollouts.set(r.id, r);
  }
  getRollout(id: string): StoredRollout | undefined {
    return this.rollouts.get(id);
  }
  listRollouts(): StoredRollout[] {
    return [...this.rollouts.values()];
  }
}
