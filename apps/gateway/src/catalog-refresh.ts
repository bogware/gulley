/**
 * Manual cost-catalog refresh. Fetches the models.dev catalog and writes it to a
 * file the gateway loads on boot (MODELS_CATALOG_FILE). This is a deliberate
 * operator action — the gateway never auto-fetches pricing at runtime.
 *
 *   pnpm --filter @gulley/gateway catalog:refresh -- --out ./models.catalog.json
 *   pnpm --filter @gulley/gateway catalog:refresh                 # preview only
 */
import { fetchModelsDev, writeCatalogFile } from '@gulley/catalog';

function argFor(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const url = argFor('--url') ?? process.env['MODELS_DEV_URL'];
  const out = argFor('--out') ?? process.env['MODELS_CATALOG_FILE'];

  const entries = await fetchModelsDev(url ? { url } : {});
  const providers = new Set(entries.map((e) => e.provider));
  process.stdout.write(
    `fetched ${entries.length} priced models across ${providers.size} providers\n`,
  );

  if (out) {
    writeCatalogFile(out, entries);
    process.stdout.write(`wrote ${out}\n`);
  } else {
    process.stdout.write(`(preview) e.g. ${JSON.stringify(entries.slice(0, 3))}\n`);
    process.stdout.write('pass --out <file> (or set MODELS_CATALOG_FILE) to persist\n');
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
