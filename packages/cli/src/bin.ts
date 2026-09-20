/* c8 ignore start — thin process wrapper; the logic in cli.ts is what's tested. */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { runCli, type CliIo } from './cli';
import { BROKER_REQUEST_TIMEOUT_MS } from './device-login';

const LOCK_STALE_MS = 30_000;
/** Longer than the stale threshold: a live holder is waited out, never evicted. */
const LOCK_WAIT_MS = 45_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but not ours (still alive); ESRCH = gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * A cross-process lock via an exclusive-create lock file next to the credentials.
 * The holder's pid is written into it, so an abandoned lock (a crashed helper) is
 * reclaimed only when its pid is gone — a live-but-slow holder is never evicted
 * (evicting it let two helpers rotate the same refresh token, which the broker
 * treats as theft and revokes the whole family). Reclaim is rename-then-unlink so
 * two waiters cannot both "reclaim" and both proceed.
 */
async function acquireLock(path: string): Promise<() => void> {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      };
    } catch {
      try {
        const st = statSync(lockPath);
        const holder = Number(readFileSync(lockPath, 'utf8').trim());
        const abandoned =
          Date.now() - st.mtimeMs > LOCK_STALE_MS &&
          (!Number.isFinite(holder) || !pidAlive(holder));
        if (abandoned) {
          const claim = `${lockPath}.reclaim-${process.pid}`;
          renameSync(lockPath, claim); // exactly one waiter wins the rename
          unlinkSync(claim);
        }
      } catch {
        /* raced or already reclaimed */
      }
      if (Date.now() > deadline)
        throw new Error(`could not lock ${lockPath} — another gulley process is holding it`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

const io: CliIo = {
  readText: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : undefined),
  writeText: (p, c, opts) => {
    if (opts?.secret) {
      // Atomic: a crash mid-write must never leave a truncated credentials file.
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      const tmp = `${p}.tmp-${process.pid}`;
      writeFileSync(tmp, c, { mode: 0o600 });
      renameSync(tmp, p);
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
  // Every broker call is bounded (the agent's token helper is on a session's hot path).
  fetch: (input, init) =>
    fetch(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(BROKER_REQUEST_TIMEOUT_MS),
    }),
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
