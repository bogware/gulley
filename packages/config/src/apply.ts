import { err, ok, type Result } from '@gulley/core';
import { assertEgressAllowed } from '@gulley/egress';
import { assertNoInlineSecret, type AuditSink, InlineSecretError } from '@gulley/pipeline';
import type { AccessControl, AdminPrincipal } from '@gulley/rbac';
import { contentHash, diffDocuments, type DiffSummary } from './canonical';
import type { ConfigDocument } from './document';
import type { ConfigStore, ConfigVersionStore } from './store';
import { toYaml } from './yaml';

export type ApplyError =
  | { kind: 'forbidden' }
  | { kind: 'stale'; current: number }
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

  return ok({ version: reserved, contentHash: hash, summary: applied.summary });
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
