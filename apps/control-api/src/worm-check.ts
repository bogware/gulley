/**
 * Live WORM audit-mirror check against REAL S3 Object Lock (COMPLIANCE). Creates
 * a throwaway object-locked bucket, ships a signed hash-chained audit stream in
 * batches, re-reads + verifies the chain from S3, and proves immutability: a
 * DeleteObject on a locked version and a retention-shortening are both denied.
 *
 * NOTE: COMPLIANCE-locked objects (and thus the bucket) cannot be deleted until
 * the 1-day retention elapses — the throwaway bucket lingers ~1 day by design.
 *
 *   pnpm --filter @gulley/control-api run worm:check
 */
import { InMemoryHmacSigner } from '@gulley/crypto';
import { buildBatch, type MirroredRow, S3AuditMirror, verifyMirrorChain } from '@gulley/worm';
import { createHash, randomBytes } from 'node:crypto';

const REGION = process.env['BEDROCK_REGION'] ?? 'us-east-1';

function isAccessDenied(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? '';
  const msg = e instanceof Error ? e.message : String(e);
  return /AccessDenied|Forbidden|403|not allowed/i.test(`${name} ${msg}`);
}

function looksLikeMissingPerms(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /not authorized|security token|credentials|could not load|Resolved credential/i.test(msg);
}

function chain(n: number): MirroredRow[] {
  const rows: MirroredRow[] = [];
  let prevHash: string | null = null;
  for (let seq = 1; seq <= n; seq++) {
    const rowHash: string = createHash('sha256')
      .update(`${prevHash ?? ''}:${seq}`)
      .digest('hex');
    rows.push({
      seq,
      orgId: 'org_live',
      actor: 'admin',
      action: 'proxy.request',
      target: 'anthropic',
      payload: { model: 'claude-haiku-4-5' },
      prevHash,
      rowHash,
      createdAt: `2026-08-13T00:00:${String(seq).padStart(2, '0')}.000Z`,
    });
    prevHash = rowHash;
  }
  return rows;
}

async function main(): Promise<void> {
  const bucket = `gulley-worm-check-${randomBytes(6).toString('hex')}`; // 30 chars, <=63
  const { S3Client, CreateBucketCommand, DeleteObjectCommand, PutObjectRetentionCommand } =
    await import('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: REGION });
  const signer = new InMemoryHmacSigner();

  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }));
  } catch (e) {
    if (looksLikeMissingPerms(e) || isAccessDenied(e)) {
      process.stdout.write(`⏭ WORM CHECK SKIPPED (no S3 access): ${(e as Error).message}\n`);
      return;
    }
    throw e;
  }

  try {
    const mirror = new S3AuditMirror({ bucket, region: REGION, retentionDays: 1 });
    const rows = chain(7);
    const refs = [];
    for (let i = 0; i < rows.length; i += 5) {
      refs.push(await mirror.put(await buildBatch(rows.slice(i, i + 5), signer)));
    }

    const verify = await verifyMirrorChain(mirror, signer);

    const first = refs[0]!;
    let deleteDenied = false;
    try {
      await s3.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: first.key, VersionId: first.versionId }),
      );
    } catch (e) {
      deleteDenied = isAccessDenied(e);
    }

    let shortenDenied = false;
    try {
      await s3.send(
        new PutObjectRetentionCommand({
          Bucket: bucket,
          Key: first.key,
          VersionId: first.versionId,
          Retention: { Mode: 'COMPLIANCE', RetainUntilDate: new Date(Date.now() + 3_600_000) },
        }),
      );
    } catch (e) {
      shortenDenied = isAccessDenied(e);
    }

    process.stdout.write(
      `bucket:              ${bucket}\n` +
        `chain verified:      ${verify.ok} (rows=${verify.rows} lastSeq=${verify.lastSeq})\n` +
        `delete locked ver:   denied=${deleteDenied}\n` +
        `shorten retention:   denied=${shortenDenied}\n`,
    );

    const pass =
      verify.ok && verify.rows === 7 && verify.lastSeq === 7 && deleteDenied && shortenDenied;
    process.stdout.write(pass ? '✅ WORM LIVE CHECK PASSED\n' : '❌ WORM LIVE CHECK FAILED\n');
    process.stdout.write(
      `NOTE: bucket ${bucket} + its COMPLIANCE-locked objects linger ~1 day until retention expires.\n`,
    );
    if (!pass) throw new Error('WORM immutability behaviors did not hold');
  } catch (e) {
    if (looksLikeMissingPerms(e)) {
      process.stdout.write(
        `⏭ WORM CHECK SKIPPED mid-run (no S3 access): ${(e as Error).message}\n`,
      );
      return;
    }
    throw e;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
