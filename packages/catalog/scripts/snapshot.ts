/**
 * Regenerate the bundled models.dev pricing snapshot (`data/models-dev.snapshot.json`).
 *
 * This is a MANUAL, operator-run step — the only place models.dev is ever fetched.
 * Nothing in the gateway fetches pricing at runtime and nothing schedules this.
 *
 *   pnpm --filter @gulley/catalog snapshot                       # fetch https://models.dev/api.json
 *   pnpm --filter @gulley/catalog snapshot --from ./api.json     # use a local download
 *   pnpm --filter @gulley/catalog snapshot --out ./other.json    # write elsewhere
 *
 * The raw payload (5+ MB, 200+ providers) is trimmed to the providers the gateway
 * can front — Anthropic, OpenAI, Bedrock (Anthropic models only: the adapter speaks
 * Anthropic Messages), Azure, Google, Vertex (Claude only) — and per model to the
 * fields the parser reads (`id`, `name`, `release_date`, `cost`, `limit`). The RAW
 * shape is kept so the file stays diffable against upstream and loads through the
 * same `parseModelsDev` path as a verbatim download.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseModelsDev } from '../src/models-dev';

const SOURCE = 'https://models.dev/api.json';
const DEFAULT_OUT = fileURLToPath(new URL('../data/models-dev.snapshot.json', import.meta.url));
/** Byte budget for the committed file; trim harder (drop `release_date`) if exceeded. */
const SIZE_BUDGET = 400 * 1024;

/** provider id → keep this model id? */
const KEEP: Record<string, (modelId: string) => boolean> = {
  anthropic: () => true,
  openai: () => true,
  'amazon-bedrock': (id) => id.includes('anthropic.'),
  azure: () => true,
  google: () => true,
  'google-vertex': (id) => id.startsWith('claude-'),
};
const MODEL_FIELDS = ['id', 'name', 'release_date', 'cost', 'limit'] as const;

type Json = Record<string, unknown>;

function argFor(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function fetchRaw(): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  try {
    const res = await fetch(SOURCE, { signal: ac.signal });
    if (!res.ok) throw new Error(`${SOURCE} returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function trim(raw: unknown, dropReleaseDate: boolean): Json {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('payload is not a models.dev object');
  const out: Json = {};
  for (const [providerId, keep] of Object.entries(KEEP)) {
    const prov = (raw as Json)[providerId] as Json | undefined;
    const models = prov?.['models'] as Record<string, Json> | undefined;
    if (!prov || !models || typeof models !== 'object')
      throw new Error(`provider ${providerId} missing from payload`);
    const kept: Record<string, Json> = {};
    for (const [modelId, m] of Object.entries(models)) {
      if (!keep(modelId)) continue;
      const slim: Json = {};
      for (const f of MODEL_FIELDS) {
        if (dropReleaseDate && f === 'release_date') continue;
        if (f in m) slim[f] = m[f];
      }
      kept[modelId] = slim;
    }
    out[providerId] = { id: prov['id'], name: prov['name'], models: kept };
  }
  return out;
}

async function main(): Promise<void> {
  const from = argFor('--from');
  const outPath = argFor('--out') ?? DEFAULT_OUT;
  const raw: unknown = from ? JSON.parse(readFileSync(from, 'utf8')) : await fetchRaw();
  process.stdout.write(`source: ${from ?? SOURCE}\n`);

  let dropReleaseDate = false;
  let body = '';
  for (;;) {
    const trimmed = trim(raw, dropReleaseDate);
    const snapshot: Json = {
      _meta: {
        source: SOURCE,
        snapshotAt: new Date().toISOString().slice(0, 10),
        note:
          'Trimmed models.dev catalog bundled as the offline pricing fallback. ' +
          'Regenerate by hand with `pnpm --filter @gulley/catalog snapshot [--from <api.json>]`; ' +
          'never fetched at runtime, never on a schedule. Keys starting with `_` are ignored by the parser.',
      },
      ...trimmed,
    };
    body = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (Buffer.byteLength(body) <= SIZE_BUDGET || dropReleaseDate) break;
    process.stdout.write(`over ${SIZE_BUDGET} bytes; dropping release_date\n`);
    dropReleaseDate = true;
  }

  // Prove the file loads through the runtime parser before writing it.
  const entries = parseModelsDev(JSON.parse(body));
  if (entries.length === 0) throw new Error('trimmed snapshot yields no priced models');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, body, 'utf8');

  const bytes = statSync(outPath).size;
  const perProvider = new Map<string, number>();
  for (const e of entries) perProvider.set(e.provider, (perProvider.get(e.provider) ?? 0) + 1);
  process.stdout.write(`wrote ${outPath} (${bytes} bytes)\n`);
  for (const [p, n] of [...perProvider].sort())
    process.stdout.write(`  ${p}: ${n} priced models\n`);
  if (bytes > SIZE_BUDGET) {
    process.stdout.write(`WARNING: ${bytes} bytes exceeds the ${SIZE_BUDGET}-byte budget\n`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
