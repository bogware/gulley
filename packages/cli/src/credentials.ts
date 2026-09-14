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

export function parseCredentials(text: string | undefined): CredentialsFile {
  if (!text || !text.trim()) return { version: 1, profiles: {} };
  const parsed = JSON.parse(text) as Partial<CredentialsFile>;
  if (parsed.version !== 1 || !parsed.profiles || typeof parsed.profiles !== 'object') {
    throw new Error('unrecognized credentials file format');
  }
  return { version: 1, profiles: parsed.profiles };
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
