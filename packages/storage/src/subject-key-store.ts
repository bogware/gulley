import { randomBytes } from 'node:crypto';
import type { Encryptor, EnvelopeCiphertext, SubjectKeyStore } from '@gulley/crypto';
import { eq } from 'drizzle-orm';

import type { Database } from './db';
import { subjectKey } from './schema';

/**
 * Postgres-backed per-subject crypto-shred key registry. Each subject's 256-bit data
 * key is held WRAPPED by the deployment master `Encryptor` (the customer's BYOK key) in
 * `subject_key.wrapped_key`; `shred` NULLs it (destroying the key) so every ciphertext
 * under that subject becomes permanently unreadable, recording `shredded_at`. A new
 * write after a shred gets a FRESH key (old data stays shredded).
 */
const KEY_CLASS = 'subject-key';

export class PostgresSubjectKeyStore implements SubjectKeyStore {
  constructor(
    private readonly db: Database,
    private readonly master: Encryptor,
  ) {}

  private async load(subject: string): Promise<Buffer | undefined> {
    const rows = await this.db
      .select()
      .from(subjectKey)
      .where(eq(subjectKey.subject, subject))
      .limit(1);
    const wrapped = rows[0]?.wrappedKey;
    if (!wrapped) return undefined; // never created, or shredded (NULL)
    // The subject key is master-wrapped (BYOK) with the subject as AAD.
    const raw = await this.master.decrypt(wrapped as EnvelopeCiphertext, { aad: subject });
    return Buffer.from(raw);
  }

  async getOrCreate(subject: string): Promise<Buffer> {
    const existing = await this.load(subject);
    if (existing) return existing;
    const key = randomBytes(32);
    const wrapped = await this.master.encrypt(key, { keyClass: KEY_CLASS, aad: subject });
    await this.db
      .insert(subjectKey)
      .values({ subject, wrappedKey: wrapped, shreddedAt: null })
      .onConflictDoUpdate({
        target: subjectKey.subject,
        set: { wrappedKey: wrapped, shreddedAt: null },
      });
    return key;
  }

  async get(subject: string): Promise<Buffer | undefined> {
    return this.load(subject);
  }

  async shred(subject: string): Promise<void> {
    const now = new Date();
    await this.db
      .insert(subjectKey)
      .values({ subject, wrappedKey: null, shreddedAt: now })
      .onConflictDoUpdate({
        target: subjectKey.subject,
        set: { wrappedKey: null, shreddedAt: now },
      });
  }
}
