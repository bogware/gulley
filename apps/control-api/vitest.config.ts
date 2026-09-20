import { defineConfig } from 'vitest/config';

// The *.pg.test.ts suites boot a real (WASM) Postgres via PGlite and replay every
// migration in beforeAll. Under a fully parallel run (one fork per file on a loaded
// CI box) that setup routinely exceeds Vitest's 10 s default hook budget, which
// would fail the whole file before a single assertion ran. Give setup/teardown a
// generous, explicit budget; the per-test timeout stays at the default.
export default defineConfig({
  test: {
    hookTimeout: 60_000,
  },
});
