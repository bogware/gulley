// Validates the deploy manifests without a Kubernetes/Helm toolchain:
//  - plain-YAML files (Chart.yaml, values.yaml, docker-compose.prod.yml) parse and
//    carry the structural invariants the chart relies on;
//  - values.schema.json is valid JSON;
//  - each Helm template is non-empty with balanced {{ }} delimiters and renders a
//    plausible manifest header.
// Run via `bash ci/helm-check.sh`. Exits non-zero on the first failure.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chart = join(root, 'deploy/helm/gulley');
let failures = 0;
const fail = (msg) => {
  failures++;
  process.stderr.write(`FAIL ${msg}\n`);
};
const ok = (msg) => process.stdout.write(`ok   ${msg}\n`);

function readYaml(rel) {
  return parse(readFileSync(join(root, rel), 'utf8'));
}

// --- Chart.yaml ---
try {
  const c = readYaml('deploy/helm/gulley/Chart.yaml');
  if (c.apiVersion !== 'v2') fail('Chart.yaml apiVersion must be v2');
  if (c.name !== 'gulley') fail('Chart.yaml name must be gulley');
  if (!c.version) fail('Chart.yaml missing version');
  if (!c.appVersion) fail('Chart.yaml missing appVersion');
  ok('Chart.yaml');
} catch (e) {
  fail(`Chart.yaml parse: ${e.message}`);
}

// --- values.yaml ---
let values;
try {
  values = readYaml('deploy/helm/gulley/values.yaml');
  for (const path of ['image.repository', 'gateway.port', 'controlApi.port', 'gateway.command']) {
    const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), values);
    if (v === undefined) fail(`values.yaml missing ${path}`);
  }
  if (!Array.isArray(values.gateway.command) || values.gateway.command[0] !== 'node')
    fail('values.yaml gateway.command must be a node argv array');
  ok('values.yaml');
} catch (e) {
  fail(`values.yaml parse: ${e.message}`);
}

// --- values.schema.json ---
try {
  const schema = JSON.parse(readFileSync(join(chart, 'values.schema.json'), 'utf8'));
  if (schema.type !== 'object' || !schema.properties) fail('values.schema.json malformed');
  ok('values.schema.json');
} catch (e) {
  fail(`values.schema.json parse: ${e.message}`);
}

// --- templates: balanced delimiters + a kind/define header ---
const tplDir = join(chart, 'templates');
for (const file of readdirSync(tplDir)) {
  const text = readFileSync(join(tplDir, file), 'utf8');
  const opens = (text.match(/\{\{/g) ?? []).length;
  const closes = (text.match(/\}\}/g) ?? []).length;
  if (opens !== closes) {
    fail(`templates/${file}: unbalanced {{ }} (${opens} vs ${closes})`);
    continue;
  }
  if (file.endsWith('.yaml')) {
    if (!/\bkind:\s*\w+/.test(text)) fail(`templates/${file}: no 'kind:' — not a manifest?`);
  } else if (file.endsWith('.tpl')) {
    if (!/\{\{-?\s*define\b/.test(text)) fail(`templates/${file}: helper has no define`);
  }
  ok(`templates/${file}`);
}

// --- docker-compose.prod.yml (one-command deploy) ---
try {
  const dc = readYaml('deploy/docker-compose.prod.yml');
  const svc = dc.services ?? {};
  for (const name of [
    'postgres',
    'redis-cache',
    'redis-counters',
    'redis-vector',
    'gateway',
    'control-api',
  ]) {
    if (!svc[name]) fail(`docker-compose.prod.yml missing service ${name}`);
  }
  // The counters + vector Redis must never evict (budget/rate-limit correctness).
  for (const r of ['redis-counters', 'redis-vector']) {
    const cmd = (svc[r]?.command ?? []).join(' ');
    if (!cmd.includes('noeviction')) fail(`${r} must set --maxmemory-policy noeviction`);
  }
  if ((svc['redis-cache']?.command ?? []).join(' ').includes('noeviction'))
    fail('redis-cache must be allkeys-lru, not noeviction');
  // Both planes run the one image with a plane-selecting command. A service may either
  // use the image's DEFAULT command (which starts that plane from its app dir — the
  // gateway does this) or override it; an override must launch the plane's main.ts, and
  // `tsx` only resolves from the app dir, so the path is workdir-relative
  // (`src/main.ts` with working_dir /app/apps/<app>) or absolute (`apps/<app>/src/main.ts`).
  for (const app of ['gateway', 'control-api']) {
    const def = svc[app] ?? {};
    const cmd = def.command ?? [];
    if (cmd.length === 0) continue; // image default — starts the correct plane
    const wd = def.working_dir ?? '';
    const launchesMain = cmd[0] === 'node' && cmd.some((a) => a.includes('src/main.ts'));
    const rightApp =
      cmd.some((a) => a.includes(`apps/${app}/src/main.ts`)) || wd.includes(`apps/${app}`);
    if (!launchesMain || !rightApp)
      fail(`${app} command must launch apps/${app}/src/main.ts (workdir-relative or absolute)`);
  }
  ok('docker-compose.prod.yml');
} catch (e) {
  fail(`docker-compose.prod.yml parse: ${e.message}`);
}

if (failures > 0) {
  process.stderr.write(`\n${failures} manifest check(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\nAll deploy manifests valid.\n');
