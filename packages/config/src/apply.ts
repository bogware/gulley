import { err, ok, type Result } from '@gulley/core';
import { assertEgressAllowed } from '@gulley/egress';
import { assertNoInlineSecret, type AuditSink, InlineSecretError } from '@gulley/pipeline';
import type { AccessControl, AdminPrincipal } from '@gulley/rbac';
import { contentHash, diffDocuments, type DiffSummary } from './canonical';
import { type ConfigDocument, validateConfigDocument } from './document';
import type { ConfigStore, ConfigVersionStore } from './store';
import { toYaml } from './yaml';

export type ApplyError =
  | { kind: 'forbidden' }
  | { kind: 'stale'; current: number }
  | { kind: 'validation'; detail: string }
  | { kind: 'inline_secret'; detail: string }
  | { kind: 'egress'; detail: string }
  | { kind: 'internal'; detail: string };

export interface ApplyOutcome {
  version: number;
  contentHash: string;
  summary: DiffSummary;
}

export interface ApplyDeps {
  store: ConfigStore;
  versions: ConfigVersionStore;
  audit: AuditSink;
  access: AccessControl;
  egressAllowlist?: ReadonlySet<string>;
  now?: () => number;
  /** Post-commit broadcast hook: fired AFTER a version is durably appended, so
   *  the change can be signalled to gateway replicas. Best-effort — a throw is
   *  swallowed (the durable write already succeeded). Kept as a bare callback so
   *  @gulley/config stays free of storage/transport dependencies. */
  onApplied?: (event: { version: number; contentHash: string }) => Promise<void> | void;
}

function checkEgress(doc: ConfigDocument, allowlist?: ReadonlySet<string>): string | null {
  for (const org of doc.orgs) {
    for (const ws of org.workspaces) {
      for (const p of ws.providers) {
        if (p.baseUrl) {
          try {
            assertEgressAllowed(p.baseUrl, { allowlist });
          } catch (e) {
            return (e as Error).message;
          }
        }
      }
    }
  }
  return null;
}

/** Dry-run diff of a desired doc against the current (readable) config. */
export async function plan(
  desired: ConfigDocument,
  store: ConfigStore,
  readableOrgIds: ReadonlySet<string> | '*',
): Promise<DiffSummary> {
  const current = await store.exportDocument(readableOrgIds);
  return diffDocuments(current, desired);
}

/**
 * Apply a desired document through the same guarded path as UI writes: secret
 * guard → egress guard → RBAC authorization → optimistic-concurrency version
 * reservation → reconcile → append a config_version + a hash-chained audit row.
 */
export async function applyConfig(
  desired: ConfigDocument,
  baseVersion: number,
  admin: AdminPrincipal,
  deps: ApplyDeps,
): Promise<Result<ApplyOutcome, ApplyError>> {
  // Deep-validate BEFORE reserving a version, so a malformed doc can't half-apply
  // (mutate stores + advance the version counter) and then 500 in reconcile.
  const invalid = validateConfigDocument(desired);
  if (invalid) return err({ kind: 'validation', detail: invalid });

  try {
    assertNoInlineSecret(desired);
  } catch (e) {
    if (e instanceof InlineSecretError) return err({ kind: 'inline_secret', detail: e.message });
    return err({ kind: 'internal', detail: (e as Error).message });
  }

  const egress = checkEgress(desired, deps.egressAllowlist);
  if (egress) return err({ kind: 'egress', detail: egress });

  if (!(await deps.store.authorize(desired, { admin, access: deps.access }))) {
    return err({ kind: 'forbidden' });
  }

  const currentVersion = await deps.versions.currentVersion();
  if (baseVersion !== currentVersion) return err({ kind: 'stale', current: currentVersion });
  const reserved = await deps.versions.tryReserve(baseVersion);
  if (reserved === null) {
    return err({ kind: 'stale', current: await deps.versions.currentVersion() });
  }

  // Reconcile → export → audit → version-record. These are separate deps, so on
  // Postgres the reconcile is atomic within ITS transaction and the version row
  // is a separate append; a mid-way failure surfaces a clean error (no blank
  // version row is written — tryReserve is a pure read). A rare concurrent apply
  // at the same base version loses on the version PK. Full cross-step atomicity
  // (reconcile + version row in one tx) remains a future hardening.
  try {
    const applied = await deps.store.reconcile(desired, { admin, access: deps.access });
    const newDoc = await deps.store.exportDocument('*');
    const hash = contentHash(newDoc);
    const auditRow = await deps.audit.append({
      orgId: null,
      actor: admin.subject,
      action: 'config.apply',
      target: `v${reserved}`,
      payload: { version: reserved, contentHash: hash, summary: applied.summary },
    });
    await deps.versions.append({
      version: reserved,
      contentHash: hash,
      yaml: toYaml(newDoc),
      actor: admin.subject,
      summary: applied.summary,
      auditSeq: auditRow.seq,
      createdAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
    });
    // Broadcast AFTER the durable commit (never before) so a subscriber can never
    // react to a half-applied version. Best-effort: the write already succeeded.
    if (deps.onApplied) {
      try {
        await deps.onApplied({ version: reserved, contentHash: hash });
      } catch {
        /* best-effort broadcast; correctness comes from the durable version */
      }
    }
    return ok({ version: reserved, contentHash: hash, summary: applied.summary });
  } catch (err2) {
    return err({ kind: 'internal', detail: (err2 as Error).message });
  }
}

export interface DriftReport {
  drifted: boolean;
  expected: string | null;
  actual: string;
}

/** Report (never heal) drift between the DB config and the last applied version. */
export async function detectDrift(deps: {
  store: ConfigStore;
  versions: ConfigVersionStore;
}): Promise<DriftReport> {
  const last = await deps.versions.current();
  const actual = contentHash(await deps.store.exportDocument('*'));
  if (!last) return { drifted: false, expected: null, actual };
  return { drifted: last.contentHash !== actual, expected: last.contentHash, actual };
}
