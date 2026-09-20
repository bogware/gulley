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
  // The runtime image is distroless with node as ENTRYPOINT: a command is the bundled
  // entry file (relative to WORKDIR /app), never `node --import tsx …`.
  for (const [plane, entry] of [
    ['gateway', 'dist/gateway/main.mjs'],
    ['controlApi', 'dist/control-api/main.mjs'],
  ]) {
    const cmd = values[plane]?.command;
    if (!Array.isArray(cmd) || cmd[0] !== entry)
      fail(`values.yaml ${plane}.command must start with ${entry} (bundled runtime entry)`);
  }
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
  // Both planes run the one image with a plane-selecting command: the bundled entry
  // (the image's ENTRYPOINT is node). A service may use the image default (gateway).
  for (const [app, entry] of [
    ['gateway', 'dist/gateway/main.mjs'],
    ['control-api', 'dist/control-api/main.mjs'],
  ]) {
    const cmd = svc[app]?.command ?? [];
    if (cmd.length === 0) continue; // image default — starts the gateway
    if (cmd[0] !== entry) fail(`${app} command must be ['${entry}'] (bundled runtime entry)`);
  }
  if (!svc['migrate'] || (svc['migrate'].command ?? [])[0] !== 'dist/control-api/migrate.mjs')
    fail(
      'docker-compose.prod.yml must run the one-off migrate service (dist/control-api/migrate.mjs)',
    );
  for (const app of ['gateway', 'control-api']) {
    if (svc[app]?.depends_on?.migrate?.condition !== 'service_completed_successfully')
      fail(`${app} must depend on migrate: service_completed_successfully`);
    if (!svc[app]?.stop_grace_period)
      fail(`${app} needs a stop_grace_period above SHUTDOWN_GRACE_MS`);
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
