import { statSync } from 'node:fs';
import type { ModelCatalog } from './catalog';
import { loadCatalogFromFile, reloadCatalogFile } from './file';

export interface WatchCatalogOptions {
  /** Poll interval. The timer is unref'd so it never holds the process open. */
  intervalMs: number;
  log?: (msg: string, err?: unknown) => void;
  /** Reload INTO this instance (`replace`, keeping its overrides) instead of building a
   *  fresh `ModelCatalog` per change; `onChange` then receives this same instance. */
  into?: ModelCatalog;
}

interface Sig {
  mtimeMs: number;
  size: number;
}

/** `undefined` when the file is missing. Other stat errors propagate. */
function signature(path: string): Sig | undefined {
  const st = statSync(path, { throwIfNoEntry: false });
  return st ? { mtimeMs: st.mtimeMs, size: st.size } : undefined;
}

const same = (a: Sig | undefined, b: Sig | undefined): boolean =>
  a === b || (!!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size);

/**
 * Poll a catalog file's mtime/size and reload it when either changes — the
 * no-redeploy half of the manual-refresh story: an operator (or a sidecar that pulls a
 * vetted file) writes the file; nothing here ever fetches. A reload that fails to read
 * or parse keeps the previous catalog and logs; nothing escapes the timer. Returns a
 * stop function.
 */
export function watchCatalogFile(
  path: string,
  onChange: (catalog: ModelCatalog) => void,
  opts: WatchCatalogOptions,
): () => void {
  if (!(Number.isFinite(opts.intervalMs) && opts.intervalMs > 0))
    throw new RangeError(`watchCatalogFile: intervalMs must be > 0 (got ${opts.intervalMs})`);
  const log = opts.log ?? (() => {});
  let last: Sig | undefined;
  try {
    last = signature(path);
  } catch (err) {
    log(`catalog watch: cannot stat ${path}; will retry`, err);
  }

  const tick = (): void => {
    let sig: Sig | undefined;
    try {
      sig = signature(path);
    } catch (err) {
      log(`catalog watch: cannot stat ${path}; keeping previous catalog`, err);
      return;
    }
    if (same(sig, last)) return;
    last = sig;
    if (!sig) {
      log(`catalog watch: ${path} disappeared; keeping previous catalog`);
      return;
    }
    try {
      let catalog: ModelCatalog;
      if (opts.into) {
        reloadCatalogFile(path, opts.into);
        catalog = opts.into;
      } else {
        catalog = loadCatalogFromFile(path);
      }
      onChange(catalog);
      log(`catalog reloaded from ${path} (${catalog.size} models)`);
    } catch (err) {
      log(`catalog reload from ${path} failed; keeping previous catalog`, err);
    }
  };

  const timer = setInterval(tick, opts.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
