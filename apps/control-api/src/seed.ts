/**
 * Dev seed / key-mint CLI. Ensures an org + workspace exist and mints a virtual
 * key, printing the `gk_` token exactly once so you can point Claude Code at the
 * gateway. Not a production admin flow — that lands with the control-plane UI.
 *
 *   DATABASE_URL=... GULLEY_KEY_PEPPER=... pnpm --filter @gulley/control-api seed
 *     [--org "My Org"] [--workspace "Default"] [--name "dev-key"]
 */
import { generateVirtualKey } from '@gulley/auth';
import { createDatabase, schema } from '@gulley/storage';
import { and, eq } from 'drizzle-orm';

interface Args {
  org: string;
  workspace: string;
  name: string;
}

function parseArgs(argv: string[]): Args {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      out[key] = next && !next.startsWith('--') ? (argv[++i] as string) : 'true';
    }
  }
  return {
    org: out['org'] ?? 'Default Org',
    workspace: out['workspace'] ?? 'Default',
    name: out['name'] ?? 'dev-key',
  };
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  const pepper = process.env['GULLEY_KEY_PEPPER'];
  if (!url) throw new Error('DATABASE_URL is required');
  if (!pepper) throw new Error('GULLEY_KEY_PEPPER is required');

  const args = parseArgs(process.argv.slice(2));
  const db = createDatabase(url, 1);

  const org =
    (await db.select().from(schema.org).where(eq(schema.org.name, args.org)).limit(1))[0] ??
    (await db.insert(schema.org).values({ name: args.org }).returning())[0];
  if (!org) throw new Error('failed to create org');

  const workspace =
    (
      await db
        .select()
        .from(schema.workspace)
        .where(and(eq(schema.workspace.orgId, org.id), eq(schema.workspace.name, args.workspace)))
        .limit(1)
    )[0] ??
    (
      await db.insert(schema.workspace).values({ orgId: org.id, name: args.workspace }).returning()
    )[0];
  if (!workspace) throw new Error('failed to create workspace');

  const gen = generateVirtualKey(pepper);
  const key = (
    await db
      .insert(schema.virtualKey)
      .values({
        workspaceId: workspace.id,
        name: args.name,
        keyPrefix: gen.keyPrefix,
        keyHash: gen.keyHash,
      })
      .returning()
  )[0];
  if (!key) throw new Error('failed to create virtual key');

  process.stdout.write(
    [
      '',
      `  org:        ${org.id}  (${org.name})`,
      `  workspace:  ${workspace.id}  (${workspace.name})`,
      `  key id:     ${key.id}  (${args.name})`,
      '',
      '  Virtual key (shown once — store it now):',
      '',
      `    ${gen.token}`,
      '',
      '  Point Claude Code at the gateway:',
      '',
      '    export ANTHROPIC_BASE_URL=http://localhost:8080',
      `    export ANTHROPIC_API_KEY=${gen.token}`,
      '',
    ].join('\n'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
