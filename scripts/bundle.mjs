#!/usr/bin/env node
/**
 * Pre-bundle the two apps for the runtime image.
 *
 * The runtime image runs plain `node` on a distroless base with NO TypeScript
 * toolchain: every `@gulley/*` workspace package (TypeScript source, no build step)
 * is bundled INTO each entry by esbuild, while third-party packages stay external
 * and are installed as production-only node_modules beside each entry (`pnpm deploy`).
 *
 *   node scripts/bundle.mjs            # → dist/{gateway,control-api}/*.mjs + dist/migrations
 *   GULLEY_VERSION=1.2.3 GULLEY_BUILD_SHA=abc1234 node scripts/bundle.mjs
 *
 * Entries: the two servers, the gateway doctor, the control-api migrate + audit-verify
 * CLIs. The migration SQL + journal are copied so `migrate.mjs` and the schema-version
 * readiness probe read them from the image (GULLEY_MIGRATIONS_DIR).
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');

const version =
  process.env.GULLEY_VERSION ??
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ??
  '0.0.0';
const sha = process.env.GULLEY_BUILD_SHA ?? '';

/** Bundle `@gulley/*` (workspace TypeScript); everything else (third-party packages and
 *  Node builtins) stays external and resolves from the production node_modules beside the entry. */
const workspaceOnly = {
  name: 'workspace-only',
  setup(b) {
    b.onResolve({ filter: /^[^./#]/ }, (args) => {
      if (args.kind === 'entry-point' || isAbsolute(args.path)) return null;
      if (args.path.startsWith('@gulley/')) return null; // let esbuild resolve + bundle it
      return { path: args.path, external: true };
    });
  },
};

const ENTRIES = [
  ['apps/gateway/src/main.ts', 'gateway/main.mjs'],
  ['apps/gateway/src/doctor.ts', 'gateway/doctor.mjs'],
  ['apps/control-api/src/main.ts', 'control-api/main.mjs'],
  ['apps/control-api/src/migrate.ts', 'control-api/migrate.mjs'],
  ['apps/control-api/src/audit-verify.ts', 'control-api/audit-verify.mjs'],
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const [entry, target] of ENTRIES) {
  const outfile = join(out, target);
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [join(root, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    // Bundle the workspace packages (TypeScript source); leave every third-party
    // package external so it resolves from the production node_modules beside the entry.
    plugins: [workspaceOnly],
    define: {
      __GULLEY_VERSION__: JSON.stringify(version),
      __GULLEY_BUILD_SHA__: JSON.stringify(sha),
    },
    // ESM bundles have no `require`; a few CJS-flavoured deps are external anyway,
    // but give any inlined CJS shim a working require just in case.
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    logLevel: 'info',
  });
}

// Migrations travel with the image: the migrate entry applies them and the readiness
// probe compares the journal with the database's applied set.
cpSync(join(root, 'packages/storage/migrations'), join(out, 'migrations'), { recursive: true });

writeFileSync(
  join(out, 'build.json'),
  `${JSON.stringify({ version, sha, builtAt: new Date().toISOString(), node: process.version }, null, 2)}\n`,
);
// `.mjs` files are ESM regardless, but a nearest package.json keeps Node's loader
// (and any tooling) from walking up into the workspace root.
writeFileSync(
  join(out, 'package.json'),
  `${JSON.stringify({ name: 'gulley-dist', private: true, type: 'module' }, null, 2)}\n`,
);

console.log(
  `bundled ${ENTRIES.length} entries → dist/ (version ${version}${sha ? ` @ ${sha}` : ''})`,
);
