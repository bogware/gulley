import type { EnvelopeCiphertext } from '@gulley/crypto';
import type { FastifyInstance } from 'fastify';

import { adminRoute, notFound, visibleWorkspaceIds } from './admin';
import type { ControlContext } from './context';

/**
 * Mask-vault reveal (M22 D). `GET /admin/mask-vault/:requestId` decrypts and returns
 * the guardrail-mask token↔original map for a masked request, so an authorized admin
 * can de-tokenize a response the gateway masked. Deny-by-default and high-privilege:
 *
 * - `guardrail:reveal` permission (owner-only — it exposes raw secret/PII VALUES),
 *   AND the row's workspace must be visible to the caller (same as /admin/logs).
 * - Decryption uses the SAME KMS/envelope key the gateway encrypted with, with the
 *   AAD re-derived as `${requestId}:${workspaceId}:${direction}` (a mismatch fails
 *   closed). The store never holds plaintext.
 * - Every successful reveal is hash-chain audited (`guardrail.reveal`) with only the
 *   actor + requestId + token COUNT — never the values.
 *
 * Served only when both a store and an encryptor are wired; otherwise `501`.
 */
export function registerMaskVaultRoutes(app: FastifyInstance, ctx: ControlContext): void {
  app.get(
    '/admin/mask-vault/:requestId',
    adminRoute(ctx, async (request, reply, admin) => {
      const store = ctx.maskVault;
      const encryptor = ctx.maskVaultEncryptor;
      if (!store || !encryptor) {
        return reply
          .code(501)
          .send({ error: { type: 'not_configured', message: 'mask-vault reveal not enabled' } });
      }
      const requestId = (request.params as { requestId: string }).requestId;
      const records = await store.list(requestId);

      // Deny-by-default WITHOUT an existence oracle: an unauthorized caller (no
      // workspace visibility, or not owner/`guardrail:reveal`) gets the SAME 404 as a
      // non-existent record, so the 403-vs-404 split can't reveal which requests held
      // masked PII. Only an authorized caller ever learns existence.
      const workspaceId = records[0]?.workspaceId;
      const orgId = records[0]?.orgId ?? undefined;
      const authorized =
        workspaceId !== undefined &&
        visibleWorkspaceIds(ctx, admin).has(workspaceId) &&
        (await ctx.access.can(admin, 'guardrail:reveal', { orgId, workspaceId }));
      if (records.length === 0 || !authorized) return notFound(reply, 'mask vault');

      const reveals: Array<{
        direction: string;
        tokenCount: number;
        tokens: Record<string, string>;
      }> = [];
      for (const rec of records) {
        let entries: Array<[string, string]>;
        try {
          const plaintext = await encryptor.decrypt(rec.ciphertext as EnvelopeCiphertext, {
            aad: `${requestId}:${workspaceId}:${rec.direction}`,
          });
          // Parse INSIDE the guard so a post-decrypt error also fails closed with a
          // generic message (never echo a decrypted plaintext fragment to the client).
          entries = JSON.parse(Buffer.from(plaintext).toString('utf8')) as Array<[string, string]>;
        } catch (err) {
          // A crypto-shred is a DELIBERATE, provable erasure — tell the (already
          // authorized) owner so, rather than pretending the key was merely wrong.
          if (err instanceof Error && err.message.startsWith('crypto-shredded')) {
            return reply.code(410).send({
              error: {
                type: 'crypto_shredded',
                message: "this subject's mask-vault data was crypto-shredded and is unrecoverable",
              },
            });
          }
          // Decrypt/parse failure (wrong key / tampered / AAD mismatch) — fail closed.
          return reply
            .code(502)
            .send({ error: { type: 'decrypt_failed', message: 'could not decrypt mask vault' } });
        }
        reveals.push({
          direction: rec.direction,
          tokenCount: rec.tokenCount,
          tokens: Object.fromEntries(entries),
        });
      }

      await ctx.audit.append({
        orgId: orgId ?? null,
        actor: admin.subject,
        action: 'guardrail.reveal',
        target: requestId,
        // NEVER the values — only who revealed what, and how many tokens.
        payload: {
          requestId,
          directions: reveals.map((r) => r.direction),
          tokenCount: reveals.reduce((n, r) => n + r.tokenCount, 0),
        },
      });

      return reply.send({ requestId, reveals });
    }),
  );
}
