/**
 * Regenerate docs/CONFORMANCE.md (and its JSON twin) from the contract conformance
 * suite: `pnpm --filter @gulley/gateway conformance:report`. A cross-platform
 * wrapper so the output paths are set the same way on Windows and POSIX.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const gatewayDir = resolve(here, '../..');
const docs = resolve(gatewayDir, '../../docs');
const result = spawnSync('npx', ['vitest', 'run', 'contract.conformance'], {
  cwd: gatewayDir,
  env: {
    ...process.env,
    CONFORMANCE_MARKDOWN: resolve(docs, 'CONFORMANCE.md'),
    CONFORMANCE_REPORT: resolve(docs, 'conformance-report.json'),
  },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
