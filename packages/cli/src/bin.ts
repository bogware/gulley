/* c8 ignore start — thin process wrapper; the logic in cli.ts is what's tested. */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { runCli, type CliIo } from './cli';

/** A cross-process lock via an exclusive-create lock file next to the credentials.
 *  A lock older than 30s is considered abandoned (a crashed helper) and reclaimed. */
async function acquireLock(path: string): Promise<() => void> {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
      closeSync(openSync(lockPath, 'wx'));
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      };
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) unlinkSync(lockPath);
      } catch {
        /* raced */
      }
      if (Date.now() > deadline) throw new Error(`could not lock ${lockPath} (stale lock?)`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

const io: CliIo = {
  readText: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : undefined),
  writeText: (p, c, opts) => {
    if (opts?.secret) {
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      writeFileSync(p, c, { mode: 0o600 });
    } else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, c);
    }
  },
  deleteFile: (p) => {
    try {
      unlinkSync(p);
    } catch {
      /* already gone */
    }
  },
  log: (l) => process.stdout.write(`${l}\n`),
  error: (l) => process.stderr.write(`${l}\n`),
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  homeDir: homedir(),
  env: process.env,
  lock: acquireLock,
};

runCli(process.argv.slice(2), io).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
/* c8 ignore stop */
