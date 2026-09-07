import type { FastifyInstance } from 'fastify';

import { adminRoute, forbidden } from './admin';
import type { ControlContext } from './context';

/**
 * BYOK crypto-shred (GDPR/CCPA right-to-erasure).
 *
 * `POST /admin/crypto-shred/:subject` destroys a subject's per-subject data key so every
 * mask-vault record encrypted under it becomes permanently unreadable — provable,
 * irreversible erasure with NO row deletion (the ciphertext stays; the key is gone). The
 * subject is the request principal (the virtual key) the gateway stamped at encrypt time.
 * `GET /admin/crypto-shred/:subject` reports whether that subject's key is still present
 * (i.e. its data is currently recoverable).
 *
 * This is deployment-global and maximally destructive, so it is gated exactly like the
 * mask-vault reveal it complements:
 *
 * - `guardrail:reveal` — owner-only (it governs the same raw PII maps) — AND at the empty
 *   deployment scope `{}`, which only a platform-wide (`*`) membership covers. So only a
 *   platform-wide owner can erase.
 * - The shred is hash-chain audited (`crypto.shred`) with the actor + subject only — the
 *   immutable audit chain, not this endpoint, is the durable proof of when/by whom.
 *
 * Served only when a subject-key store is wired (CRYPTO_SHRED_ENABLED + a DB + a mask
 * encryptor); otherwise `501`.
 */
export function registerCryptoShredRoutes(app: FastifyInstance, ctx: ControlContext): void {
  const notConfigured = { error: { type: 'not_configured', message: 'crypto-shred not enabled' } };

  app.post(
    '/admin/crypto-shred/:subject',
    adminRoute(ctx, async (request, reply, admin) => {
      const keys = ctx.subjectKeys;
      if (!keys) return reply.code(501).send(notConfigured);
      // Owner-only, deployment-wide (empty scope ⇒ only a platform-wide membership covers).
      if (!(await ctx.access.can(admin, 'guardrail:reveal', {}))) return forbidden(reply);

      const subject = (request.params as { subject: string }).subject;
      await keys.shred(subject);

      await ctx.audit.append({
        orgId: null,
        actor: admin.subject,
        action: 'crypto.shred',
        target: subject,
        // The subject id only — never any PII value or mask-vault content.
        payload: { subject },
      });

      return reply.send({ subject, shredded: true });
    }),
  );

  app.get(
    '/admin/crypto-shred/:subject',
    adminRoute(ctx, async (request, reply, admin) => {
      const keys = ctx.subjectKeys;
      if (!keys) return reply.code(501).send(notConfigured);
      if (!(await ctx.access.can(admin, 'guardrail:reveal', {}))) return forbidden(reply);

      const subject = (request.params as { subject: string }).subject;
      // `active` = a key currently exists ⇒ the subject's data is recoverable. False means
      // it was shredded (or never written). The audit chain records the erasure event.
      const active = (await keys.get(subject)) !== undefined;

      return reply.send({ subject, active });
    }),
  );
}
