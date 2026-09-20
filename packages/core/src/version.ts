/* Build-time stamping: `scripts/bundle.mjs` defines these globals via esbuild
 * `define`; under tsx (dev, tests) they are undefined and the env / fallback wins. */
declare const __GULLEY_VERSION__: string | undefined;
declare const __GULLEY_BUILD_SHA__: string | undefined;

function injected(name: 'version' | 'sha'): string | undefined {
  try {
    const v = name === 'version' ? __GULLEY_VERSION__ : __GULLEY_BUILD_SHA__;
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Build metadata for /health, build_info metrics, OTel service.version and logs.
 *  Stamped at bundle time; `GULLEY_VERSION` / `GULLEY_BUILD_SHA` env override (dev). */
export const GULLEY_BUILD: Readonly<{ version: string; sha: string }> = Object.freeze({
  version: process.env['GULLEY_VERSION'] ?? injected('version') ?? '0.0.0-dev',
  sha: process.env['GULLEY_BUILD_SHA'] ?? injected('sha') ?? '',
});

export const GULLEY_VERSION = GULLEY_BUILD.version;

/** The canonical internal representation all normalized routing translates through. */
export const CANONICAL_MODEL = 'anthropic-messages' as const;
