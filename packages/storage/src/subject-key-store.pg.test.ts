import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { InMemoryAesCipher, ShreddableCipher } from '@gulley/crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db';
import { PostgresSubjectKeyStore } from './subject-key-store';
import * as schema from './schema';

let client: PGlite;
let db: Database;

async function applyMigrations(pg: PGlite): Promise<void> {
  const dir = fileURLToPath(new URL('../migrations', import.meta.url));
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    for (let stmt of readFileSync(`${dir}/${f}`, 'utf8').split('--> statement-breakpoint')) {
      stmt = stmt.trim();
      if (!stmt) continue;
      if (/create extension.*vector/i.test(stmt)) continue;
      if (/using hnsw/i.test(stmt)) continue;
      if (/::vector/i.test(stmt)) continue;
      stmt = stmt.replace(/vector\(\d+\)/gi, 'text');
      await pg.exec(stmt);
    }
  }
}

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await applyMigrations(client);
});

afterAll(async () => {
  await client.close();
});

const dec = new TextDecoder();

describe('PostgresSubjectKeyStore (real SQL via pglite)', () => {
  it('getOrCreate persists a wrapped key and is STABLE across calls', async () => {
    const store = new PostgresSubjectKeyStore(db, new InMemoryAesCipher());
    const k1 = await store.getOrCreate('subject-a');
    expect(k1.length).toBe(32);
    const k2 = await store.getOrCreate('subject-a'); // reload from the DB (rewrapped at rest)
    expect(Buffer.compare(k1, k2)).toBe(0);
    // The row holds a WRAPPED key, never the raw bytes.
    const [row] = await db
      .select()
      .from(schema.subjectKey)
      .where(eq(schema.subjectKey.subject, 'subject-a'));
    expect(row?.wrappedKey).toBeTruthy();
    expect(JSON.stringify(row?.wrappedKey)).not.toContain(k1.toString('base64'));
  });

  it('get returns the key, then undefined after a shred (which records shreddedAt)', async () => {
    const store = new PostgresSubjectKeyStore(db, new InMemoryAesCipher());
    await store.getOrCreate('subject-b');
    expect(await store.get('subject-b')).toBeDefined();
    await store.shred('subject-b');
    expect(await store.get('subject-b')).toBeUndefined(); // key destroyed (NULL)
    const [row] = await db
      .select()
      .from(schema.subjectKey)
      .where(eq(schema.subjectKey.subject, 'subject-b'));
    expect(row?.wrappedKey).toBeNull();
    expect(row?.shreddedAt).toBeInstanceOf(Date); // provable erasure timestamp, row retained
  });

  it('getOrCreate after a shred issues a FRESH key (old key not resurrected)', async () => {
    const store = new PostgresSubjectKeyStore(db, new InMemoryAesCipher());
    const before = await store.getOrCreate('subject-c');
    await store.shred('subject-c');
    const after = await store.getOrCreate('subject-c');
    expect(Buffer.compare(before, after)).not.toBe(0);
  });

  it('end-to-end: a ShreddableCipher over this store is unrecoverable after a shred', async () => {
    const master = new InMemoryAesCipher();
    const store = new PostgresSubjectKeyStore(db, master);
    const cipher = new ShreddableCipher(master, store);
    const aad = 'req-x:ws-1:input';
    const ct = await cipher.encrypt(Buffer.from('jane@example.com'), {
      keyClass: 'mask-vault',
      aad,
      subject: 'subject-d',
    });
    expect(dec.decode(await cipher.decrypt(ct, { aad }))).toBe('jane@example.com');
    await store.shred('subject-d');
    await expect(cipher.decrypt(ct, { aad })).rejects.toThrow('crypto-shredded');
  });
});
