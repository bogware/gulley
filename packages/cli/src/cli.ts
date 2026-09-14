/**
 * `gulley` — the developer-side CLI. Pure over an injected IO port so every command
 * is unit-tested with a scripted broker and an in-memory filesystem; `bin.ts` is the
 * thin process wrapper.
 *
 *   gulley login  --broker <url> --client <id> [--profile <name>]
 *       RFC 8628 device flow against the gateway's OAuth broker. Prints the
 *       verification URL + user code, waits for consent, stores the token family.
 *   gulley token  [--profile <name>] [--force-refresh]
 *       Prints a valid gko_at_ access token (refreshing through the broker when it
 *       is about to expire). This is what Claude Code's `apiKeyHelper` and Codex's
 *       `[model_providers.gulley.auth]` command run.
 *   gulley logout [--profile <name>]
 *       Revokes the token family at the broker and deletes the local credential.
 *   gulley status [--profile <name>]
 *       Shows the stored profiles (never the secrets).
 *   gulley verify <pack.json> --pubkey <key.pem>
 *   gulley init   <pack.json> --pubkey <key.pem> [--out <path>]
 *       Verify a signed onboarding pack against the org's public key; `init` also
 *       writes/merges the agent config it carries.
 */
import { mergeClaudeSettings, mergeCodexConfig } from './client-config';
import {
  accessTokenIsFresh,
  credentialsPath,
  DEFAULT_PROFILE,
  parseCredentials,
  serializeCredentials,
  type CredentialsFile,
  type StoredProfile,
} from './credentials';
import {
  discoverBroker,
  introspectAccessToken,
  OAuthFlowError,
  pollDeviceToken,
  refreshAccessToken,
  requestDeviceAuthorization,
  revokeToken,
} from './device-login';
import { type OnboardingPack, verifyOnboardingPack } from './onboarding';

export interface CliIo {
  /** Returns undefined when the file does not exist. */
  readText(path: string): string | undefined;
  /** `secret` ⇒ create parent dirs and write with mode 0600. */
  writeText(path: string, content: string, opts?: { secret?: boolean }): void;
  deleteFile(path: string): void;
  /** stdout — ONLY the token for `gulley token` (the agent reads it verbatim). */
  log(line: string): void;
  /** stderr — human guidance, never parsed by an agent. */
  error(line: string): void;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  now(): number;
  homeDir: string;
  env: Record<string, string | undefined>;
  /** Cross-process mutual exclusion around a credential refresh (two harness
   *  sessions calling `gulley token` at once must not both rotate the SAME refresh
   *  token — the broker treats a superseded-token replay as theft and revokes the
   *  family). Returns a release function. */
  lock(path: string): Promise<() => void>;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

const USAGE = [
  'usage:',
  '  gulley login  --broker <url> --client <id> [--profile <name>]',
  '  gulley token  [--profile <name>] [--force-refresh]',
  '  gulley logout [--profile <name>]',
  '  gulley status [--profile <name>]',
  '  gulley verify <pack.json> --pubkey <key.pem>',
  '  gulley init   <pack.json> --pubkey <key.pem> [--out <path>]',
];

function loadFile(io: CliIo): { path: string; file: CredentialsFile } {
  const path = credentialsPath(io.homeDir, io.env);
  return { path, file: parseCredentials(io.readText(path)) };
}

function saveFile(io: CliIo, path: string, file: CredentialsFile): void {
  io.writeText(path, serializeCredentials(file), { secret: true });
}

function describe(err: unknown): string {
  if (err instanceof OAuthFlowError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Returns a process exit code (0 = success). Never throws for expected errors. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [cmd] = argv;
  switch (cmd) {
    case 'login':
      return login(argv.slice(1), io);
    case 'token':
      return token(argv.slice(1), io);
    case 'logout':
      return logout(argv.slice(1), io);
    case 'status':
      return status(argv.slice(1), io);
    case 'verify':
    case 'init':
      return onboarding(argv, io);
    default:
      for (const l of USAGE) io.error(l);
      return 2;
  }
}

async function login(args: string[], io: CliIo): Promise<number> {
  const brokerUrl = flag(args, 'broker');
  const clientId = flag(args, 'client');
  const profile = flag(args, 'profile') ?? clientId ?? DEFAULT_PROFILE;
  if (!brokerUrl || !clientId) {
    io.error('error: --broker <url> and --client <id> are required');
    return 2;
  }
  try {
    const endpoints = await discoverBroker(brokerUrl, io.fetch);
    const auth = await requestDeviceAuthorization(endpoints, clientId, io.fetch);
    io.error('');
    io.error(`  Open:  ${auth.verificationUriComplete ?? auth.verificationUri}`);
    io.error(`  Code:  ${auth.userCode}`);
    io.error('');
    io.error(
      `  Sign in with your organization account and confirm the code (expires in ${Math.round(
        auth.expiresIn / 60,
      )} min). Waiting…`,
    );
    const tokens = await pollDeviceToken(endpoints, clientId, auth, {
      fetch: io.fetch,
      sleep: io.sleep,
      now: io.now,
    });
    const { path, file } = loadFile(io);
    const now = io.now();
    file.profiles[profile] = {
      brokerUrl: endpoints.issuer,
      clientId,
      accessToken: tokens.accessToken,
      accessExpiresAt: now + tokens.expiresIn * 1000,
      refreshToken: tokens.refreshToken,
      updatedAt: now,
    };
    saveFile(io, path, file);
    io.error(`✓ signed in — profile "${profile}" saved to ${path}`);
    return 0;
  } catch (err) {
    io.error(`✗ login failed: ${describe(err)}`);
    return 1;
  }
}

async function token(args: string[], io: CliIo): Promise<number> {
  const profile = flag(args, 'profile') ?? DEFAULT_PROFILE;
  const force = has(args, 'force-refresh');
  const { path, file } = loadFile(io);
  const p = file.profiles[profile];
  if (!p) {
    io.error(
      `error: no credentials for profile "${profile}" — run: gulley login --broker <url> --client <id> --profile ${profile}`,
    );
    return 1;
  }
  // A fresh cached token is still checked against the broker (RFC 7662) so an admin
  // revocation, a deprovisioned account, or a reuse-triggered family kill surfaces
  // here — as "run gulley login" — instead of as opaque 401s from the gateway until
  // the cached token expires. A broker that cannot answer keeps the cached token.
  if (!force && accessTokenIsFresh(p, io.now())) {
    const endpoints = await discoverBroker(p.brokerUrl, io.fetch);
    const active = await introspectAccessToken(endpoints, p.accessToken, io.fetch);
    if (active !== false) {
      io.log(p.accessToken);
      return 0;
    }
  }
  // Serialize the refresh across concurrent helper invocations, then re-read: if
  // another process already rotated, use its result instead of replaying the
  // (now superseded) refresh token.
  const release = await io.lock(path);
  try {
    const latest = parseCredentials(io.readText(path)).profiles[profile];
    const current = latest ?? p;
    const endpoints = await discoverBroker(current.brokerUrl, io.fetch);
    if (
      latest &&
      !force &&
      latest.accessToken !== p.accessToken &&
      accessTokenIsFresh(latest, io.now()) &&
      (await introspectAccessToken(endpoints, latest.accessToken, io.fetch)) !== false
    ) {
      // Another helper process already rotated while we waited for the lock.
      io.log(latest.accessToken);
      return 0;
    }
    const rotated = await refreshAccessToken(
      endpoints,
      current.clientId,
      current.refreshToken,
      io.fetch,
    );
    const now = io.now();
    const next: StoredProfile = {
      ...current,
      accessToken: rotated.accessToken,
      accessExpiresAt: now + rotated.expiresIn * 1000,
      refreshToken: rotated.refreshToken,
      updatedAt: now,
    };
    const fresh = parseCredentials(io.readText(path));
    fresh.profiles[profile] = next;
    saveFile(io, path, fresh);
    io.log(next.accessToken);
    return 0;
  } catch (err) {
    io.error(`error: ${describe(err)}`);
    return 1;
  } finally {
    release();
  }
}

async function logout(args: string[], io: CliIo): Promise<number> {
  const profile = flag(args, 'profile') ?? DEFAULT_PROFILE;
  const { path, file } = loadFile(io);
  const p = file.profiles[profile];
  if (!p) {
    io.error(`nothing to do: no credentials for profile "${profile}"`);
    return 0;
  }
  const endpoints = await discoverBroker(p.brokerUrl, io.fetch);
  // Revoking the refresh token kills the whole family (the access token with it).
  await revokeToken(endpoints, p.refreshToken, io.fetch);
  delete file.profiles[profile];
  if (Object.keys(file.profiles).length === 0) io.deleteFile(path);
  else saveFile(io, path, file);
  io.error(`✓ signed out — profile "${profile}" revoked and removed`);
  return 0;
}

async function status(args: string[], io: CliIo): Promise<number> {
  const only = flag(args, 'profile');
  const { path, file } = loadFile(io);
  const names = Object.keys(file.profiles).filter((n) => !only || n === only);
  if (names.length === 0) {
    io.error(only ? `no credentials for profile "${only}"` : `no credentials stored (${path})`);
    return 1;
  }
  const now = io.now();
  for (const name of names) {
    const p = file.profiles[name]!;
    const left = Math.max(0, Math.round((p.accessExpiresAt - now) / 60_000));
    io.log(
      `${name}: broker=${p.brokerUrl} client=${p.clientId} access-token ${
        accessTokenIsFresh(p, now) ? `valid (~${left} min)` : 'stale (will refresh)'
      } handle=${p.accessToken.replace(/^gko_at_/, '').split('.')[0] ?? '?'}`,
    );
  }
  return 0;
}

/** `verify` / `init` — signed onboarding packs (see ./onboarding.ts). */
async function onboarding(argv: string[], io: CliIo): Promise<number> {
  const [cmd, packPath] = argv;
  if (!packPath) {
    io.error('error: pack file path required');
    return 2;
  }
  const pubkeyPath = flag(argv, 'pubkey');
  if (!pubkeyPath) {
    io.error('error: --pubkey <key.pem> required (the org onboarding public key)');
    return 2;
  }
  let pack: OnboardingPack;
  try {
    const raw = io.readText(packPath);
    if (raw === undefined) throw new Error('missing');
    pack = JSON.parse(raw) as OnboardingPack;
    // A wrapped { pack } response (from the control-api endpoint) is unwrapped.
    if ((pack as unknown as { pack?: OnboardingPack }).pack) {
      pack = (pack as unknown as { pack: OnboardingPack }).pack;
    }
  } catch {
    io.error(`error: could not read/parse pack at ${packPath}`);
    return 1;
  }
  const publicKeyPem = io.readText(pubkeyPath);
  if (publicKeyPem === undefined) {
    io.error(`error: could not read public key at ${pubkeyPath}`);
    return 1;
  }
  if (!verifyOnboardingPack(pack, publicKeyPem)) {
    io.error('✗ signature INVALID — refusing to apply (possible tampering or wrong key)');
    return 1;
  }
  io.error(
    `✓ signature valid — pack for ${pack.manifest.agent} (issued ${pack.manifest.issuedAt})`,
  );
  if (cmd === 'verify') return 0;

  // init: write the verified client config, merging into an existing file so the
  // developer's other settings survive.
  const cfg = pack.manifest.config;
  const out = flag(argv, 'out') ?? cfg.path;
  const existing = io.readText(out);
  let content: string;
  try {
    content =
      cfg.format === 'json'
        ? mergeClaudeSettings(existing, cfg.content)
        : mergeCodexConfig(existing, cfg.content);
  } catch (err) {
    io.error(
      `error: existing ${out} could not be merged (${describe(err)}) — refusing to overwrite`,
    );
    return 1;
  }
  io.writeText(out, content);
  io.error(`wrote ${pack.manifest.agent} config → ${out}`);
  for (const note of cfg.notes) io.error(`  • ${note}`);
  return 0;
}
