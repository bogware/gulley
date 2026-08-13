/**
 * Live split-KMS envelope check. Validates the in-memory cipher always, then —
 * if AWS KMS is reachable — provisions a throwaway CMK, round-trips a secret
 * through GenerateDataKey/Decrypt, and proves per-class + per-AAD isolation via
 * the KMS encryption context. Skips (exit 0) if KMS perms are absent.
 *
 *   pnpm --filter @gulley/control-api run kms:check
 */
import { InMemoryAesCipher, KmsEnvelopeEncryptor } from '@gulley/crypto';

const REGION = process.env['BEDROCK_REGION'] ?? 'us-east-1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function looksLikeMissingPerms(msg: string): boolean {
  return /AccessDenied|not authorized|security token|credentials|could not load|Resolved credential/i.test(
    msg,
  );
}

async function main(): Promise<void> {
  // The local envelope twin is always validated.
  const mem = new InMemoryAesCipher();
  const ctLocal = await mem.encrypt(encoder.encode('local-secret'), { keyClass: 'oauth-refresh' });
  const memOk = decoder.decode(await mem.decrypt(ctLocal)) === 'local-secret';
  process.stdout.write(`in-memory envelope round-trip: ${memOk}\n`);

  const { CreateKeyCommand, KMSClient, ScheduleKeyDeletionCommand } =
    await import('@aws-sdk/client-kms');
  const kms = new KMSClient({ region: REGION });

  let keyId = process.env['GULLEY_KMS_KEY_ARN']?.trim();
  let created = false;
  try {
    if (!keyId) {
      const res = await kms.send(
        new CreateKeyCommand({
          Description: 'gulley kms-check (throwaway)',
          KeyUsage: 'ENCRYPT_DECRYPT',
          KeySpec: 'SYMMETRIC_DEFAULT',
        }),
      );
      keyId = res.KeyMetadata?.KeyId;
      created = true;
    }
    if (!keyId) throw new Error('no KMS key id');

    const kenc = new KmsEnvelopeEncryptor(keyId, REGION);
    const ct = await kenc.encrypt(encoder.encode('super-secret-refresh'), {
      keyClass: 'oauth-refresh',
      aad: 'grant-123',
    });
    const ciphertextIsolated = !JSON.stringify(ct).includes('super-secret');
    const roundTrip =
      decoder.decode(await kenc.decrypt(ct, { aad: 'grant-123' })) === 'super-secret-refresh';

    let aadIsolated = false;
    try {
      await kenc.decrypt(ct, { aad: 'grant-999' });
    } catch {
      aadIsolated = true;
    }
    let classIsolated = false;
    try {
      await kenc.decrypt({ ...ct, keyClass: 'other-class' }, { aad: 'grant-123' });
    } catch {
      classIsolated = true;
    }

    if (created && keyId) {
      await kms.send(new ScheduleKeyDeletionCommand({ KeyId: keyId, PendingWindowInDays: 7 }));
    }

    process.stdout.write(
      `KMS round-trip:       ${roundTrip}\n` +
        `ciphertext isolated:  ${ciphertextIsolated}\n` +
        `per-AAD isolation:    ${aadIsolated}\n` +
        `per-class isolation:  ${classIsolated}\n` +
        (created
          ? `NOTE: scheduled throwaway key ${keyId} for deletion in 7 days (KMS minimum)\n`
          : ''),
    );
    const pass = memOk && roundTrip && ciphertextIsolated && aadIsolated && classIsolated;
    process.stdout.write(pass ? '✅ KMS LIVE CHECK PASSED\n' : '❌ KMS LIVE CHECK FAILED\n');
    if (!pass) throw new Error('KMS envelope behaviors did not hold');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (looksLikeMissingPerms(msg)) {
      process.stdout.write(`⏭ KMS CHECK SKIPPED (no KMS access): ${msg}\n`);
      return;
    }
    throw e;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
