/**
 * audit-verify — the independent compliance CLI. It re-walks the tamper-evident
 * audit hash chain (from Postgres, or a JSON export) and emits a *signed auditor
 * attestation*: verified status, row count, first/last hash, and the covered time
 * range, HMAC-signed with an operator key the auditor also holds. Exit code is
 * non-zero if the chain does not verify, so it drops straight into a CI/compliance
 * gate.
 *
 *   AUDIT_ATTESTATION_KEY=... pnpm --filter @gulley/control-api audit:verify
 *   AUDIT_ATTESTATION_KEY=... pnpm --filter @gulley/control-api audit:verify -- \
 *     --input audit-export.json --out attestation.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { GULLEY_VERSION } from '@gulley/core';
import { type AuditRow, attestAuditChain, type SignedAttestation } from '@gulley/pipeline';
import { createDatabase, readAuditRows } from '@gulley/storage';

/** Revive an exported audit-rows array (createdAt arrives as an ISO string). */
export function reviveRows(input: unknown): AuditRow[] {
  const arr = Array.isArray(input)
    ? input
    : input && typeof input === 'object' && Array.isArray((input as { rows?: unknown[] }).rows)
      ? (input as { rows: unknown[] }).rows
      : undefined;
  if (!arr) throw new Error('input is not an audit-rows array (or { rows: [...] })');
  return arr.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      seq: Number(row['seq']),
      orgId: (row['orgId'] as string | null | undefined) ?? null,
      actor: String(row['actor'] ?? ''),
      action: String(row['action'] ?? ''),
      target: (row['target'] as string | null | undefined) ?? null,
      payload: (row['payload'] as Record<string, unknown> | undefined) ?? {},
      prevHash: (row['prevHash'] as string | null | undefined) ?? null,
      rowHash: String(row['rowHash'] ?? ''),
      createdAt: new Date(String(row['createdAt'])),
    };
  });
}

/** Verify + sign in one step (thin wrapper so callers/tests share the tool label). */
export function buildAttestation(
  rows: readonly AuditRow[],
  opts: { key: string; subject?: string; generatedAt: string },
): SignedAttestation {
  return attestAuditChain(rows, {
    key: opts.key,
    toolVersion: GULLEY_VERSION,
    generatedAt: opts.generatedAt,
    ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
  });
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function loadRows(): Promise<AuditRow[]> {
  const input = arg('--input');
  if (input) return reviveRows(JSON.parse(readFileSync(input, 'utf8')));
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('no --input file and DATABASE_URL is unset');
  return readAuditRows(createDatabase(url));
}

async function main(): Promise<void> {
  const key = process.env['AUDIT_ATTESTATION_KEY'];
  if (!key) {
    process.stderr.write('AUDIT_ATTESTATION_KEY is required\n');
    process.exit(2);
  }
  const rows = await loadRows();
  const signed = buildAttestation(rows, {
    key,
    generatedAt: new Date().toISOString(),
    ...(process.env['AUDIT_ATTESTATION_SUBJECT'] !== undefined
      ? { subject: process.env['AUDIT_ATTESTATION_SUBJECT'] }
      : arg('--subject') !== undefined
        ? { subject: arg('--subject') }
        : {}),
  });
  const json = `${JSON.stringify(signed, null, 2)}\n`;
  const out = arg('--out');
  if (out) writeFileSync(out, json, 'utf8');
  else process.stdout.write(json);

  const { chain } = signed.attestation;
  process.stderr.write(
    `chain: ${chain.verified ? 'VERIFIED' : `BROKEN at seq ${chain.brokenAtSeq}`} ` +
      `(${chain.count} rows)\n`,
  );
  process.exit(chain.verified ? 0 : 1);
}

// Run only when invoked directly — `tsx src/audit-verify.ts` or the bundled
// `dist/control-api/audit-verify.mjs` — never when imported (evidence-bundle imports
// reviveRows, and the control-api bundle inlines this module: an `import.meta.url ===
// argv[1]` check was TRUE inside that bundle and ran this CLI instead of the server).
if (/audit-verify\.(ts|mjs|js)$/.test(process.argv[1] ?? '')) {
  void main();
}
