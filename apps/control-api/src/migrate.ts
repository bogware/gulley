/**
 * `gulley migrate` — apply the bundled SQL migrations to DATABASE_URL and exit.
 *
 * The runtime image has no pnpm / drizzle-kit (distroless, production deps only), so
 * the one-off migration task runs this entry instead of `pnpm db:migrate`. It uses
 * drizzle-orm's migrator over the SAME journal drizzle-kit writes, so a database
 * migrated either way is identical, and it records into `drizzle.__drizzle_migrations`
 * — the table the schema-version readiness probe reads.
 *
 *   node dist/control-api/migrate.mjs            # image (GULLEY_MIGRATIONS_DIR is set)
 *   pnpm --filter @gulley/control-api migrate    # workspace (tsx)
 *
 * Exit codes: 0 applied/up-to-date, 2 config error, 1 migration failure.
 */
import { GULLEY_BUILD } from '@gulley/core';
import { createDatabase, expectedSchemaMillis, migrationsDir, schemaStatus } from '@gulley/storage';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

async function main(): Promise<number> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('migrate: DATABASE_URL is required');
    return 2;
  }
  const dir = migrationsDir();
  const expected = expectedSchemaMillis(dir);
  if (expected === null) {
    console.error(`migrate: no migration journal at ${dir}/meta/_journal.json`);
    return 2;
  }
  const db = createDatabase(url, { max: 1, connectTimeoutMs: 10_000 });
  try {
    const before = await schemaStatus(db, expected).catch(() => undefined);
    console.log(
      `migrate: gulley ${GULLEY_BUILD.version}${GULLEY_BUILD.sha ? ` (${GULLEY_BUILD.sha})` : ''} — ` +
        `applied=${before?.applied ?? 'none'} expected=${expected} (${dir})`,
    );
    await migrate(db, { migrationsFolder: dir });
    const after = await schemaStatus(db, expected);
    if (!after.ok) {
      console.error(`migrate: schema still not current after migrate: ${after.reason ?? ''}`);
      return 1;
    }
    console.log(`migrate: schema is current (applied=${after.applied})`);
    return 0;
  } catch (err) {
    console.error(`migrate: failed — ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    // postgres.js keeps the pool alive; end it so the one-off task exits.
    await (
      db as unknown as { $client?: { end?: (o?: { timeout?: number }) => Promise<void> } }
    ).$client
      ?.end?.({ timeout: 5 })
      .catch(() => undefined);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`migrate: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
