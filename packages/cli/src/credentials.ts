/**
 * The developer-side credential cache for gateway-brokered OAuth: one profile per
 * (broker, client). Written by `gulley login`, read + rotated by `gulley token`.
 * Only ever contains tokens the broker can revoke server-side (the family handle is
 * embedded in every token), never a provider key. Stored with mode 0600.
 *
 * Pure serialization / freshness logic here; the file I/O lives behind the CLI's
 * injected IO so this is unit-tested without touching a home directory.
 */

export const DEFAULT_PROFILE = 'default';

export interface StoredProfile {
  brokerUrl: string;
  clientId: string;
  accessToken: string;
  /** Epoch ms when the access token expires (per the broker's `expires_in`). */
  accessExpiresAt: number;
  refreshToken: string;
  /** Epoch ms of the last successful login/refresh. */
  updatedAt: number;
  /** The broker's discovered endpoints, cached so `gulley token` (called by the agent
   *  on every session) does not re-run RFC 8414 discovery each time. */
  endpoints?: CachedEndpoints;
}

export interface CachedEndpoints {
  issuer: string;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  introspectionEndpoint: string;
  /** Epoch ms when discovered; re-discovered after {@link ENDPOINTS_TTL_MS}. */
  at: number;
}

/** How long cached broker endpoints are trusted before re-discovery. */
export const ENDPOINTS_TTL_MS = 6 * 3_600_000;

/** Thrown for a credentials file that exists but cannot be parsed. */
export class CorruptCredentialsError extends Error {
  constructor(readonly path: string) {
    super(
      `the credentials file at ${path} is corrupt — run \`gulley login\` again (or delete the file)`,
    );
    this.name = 'CorruptCredentialsError';
  }
}

export interface CredentialsFile {
  version: 1;
  profiles: Record<string, StoredProfile>;
}

/** `GULLEY_CREDENTIALS` overrides the location (CI / multiple homes); default
 *  `~/.gulley/credentials.json`. */
export function credentialsPath(homeDir: string, env: Record<string, string | undefined>): string {
  const override = env['GULLEY_CREDENTIALS'];
  if (override && override.trim()) return override;
  const sep = homeDir.includes('\\') && !homeDir.includes('/') ? '\\' : '/';
  return `${homeDir.replace(/[\\/]+$/, '')}${sep}.gulley${sep}credentials.json`;
}

export function parseCredentials(text: string | undefined, path = ''): CredentialsFile {
  if (!text || !text.trim()) return { version: 1, profiles: {} };
  let parsed: Partial<CredentialsFile>;
  try {
    parsed = JSON.parse(text) as Partial<CredentialsFile>;
  } catch {
    throw new CorruptCredentialsError(path);
  }
  if (parsed.version !== 1 || !parsed.profiles || typeof parsed.profiles !== 'object') {
    throw new CorruptCredentialsError(path);
  }
  return { version: 1, profiles: parsed.profiles };
}

/** Expand a leading `~` / `~/` to the home directory (the onboarding pack paths use
 *  it, e.g. `~/.codex/config.toml`; writing it literally created a `./~` folder). */
export function expandHome(path: string, homeDir: string): string {
  if (path === '~') return homeDir;
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    const sep = homeDir.includes('\\') && !homeDir.includes('/') ? '\\' : '/';
    return `${homeDir.replace(/[\\/]+$/, '')}${sep}${path.slice(2)}`;
  }
  return path;
}

export function serializeCredentials(file: CredentialsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Refresh ahead of expiry so a token handed to the agent is never on the edge:
 *  the agent caches it for its own TTL (5 min), so we need it valid for longer
 *  than that plus a little clock skew. */
export const REFRESH_AHEAD_MS = 6 * 60_000;

export function accessTokenIsFresh(
  profile: StoredProfile,
  nowMs: number,
  aheadMs = REFRESH_AHEAD_MS,
): boolean {
  return Boolean(profile.accessToken) && profile.accessExpiresAt - nowMs > aheadMs;
}
