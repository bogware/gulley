import { readFileSync, writeFileSync } from 'node:fs';
import { type OnboardingPack, verifyOnboardingPack } from './onboarding';

/**
 * `gulley codex|claude-code init` — the developer-side onboarding CLI. It VERIFIES a
 * signed onboarding pack against the org's published Ed25519 public key BEFORE
 * writing any settings, so a phished or tampered pack (wrong gateway URL, injected
 * config) is refused. Two commands:
 *   gulley verify <pack.json> --pubkey <key.pem>
 *   gulley init   <pack.json> --pubkey <key.pem> [--out <path>]
 *
 * The core (runOnboardingCli) is pure over injected IO so it is unit-tested; the
 * bottom of the file is the thin process wrapper.
 */
export interface CliIo {
  readText(path: string): string;
  writeText(path: string, content: string): void;
  log(line: string): void;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Returns a process exit code (0 = success). Never throws for expected errors. */
export function runOnboardingCli(argv: string[], io: CliIo): number {
  const [cmd, packPath] = argv;
  if (cmd !== 'verify' && cmd !== 'init') {
    io.log('usage: gulley <verify|init> <pack.json> --pubkey <key.pem> [--out <path>]');
    return 2;
  }
  if (!packPath) {
    io.log('error: pack file path required');
    return 2;
  }
  const pubkeyPath = flag(argv, 'pubkey');
  if (!pubkeyPath) {
    io.log('error: --pubkey <key.pem> required (the org onboarding public key)');
    return 2;
  }

  let pack: OnboardingPack;
  try {
    pack = JSON.parse(io.readText(packPath)) as OnboardingPack;
    // A wrapped { pack } response (from the control-api endpoint) is unwrapped.
    if ((pack as unknown as { pack?: OnboardingPack }).pack) {
      pack = (pack as unknown as { pack: OnboardingPack }).pack;
    }
  } catch {
    io.log(`error: could not read/parse pack at ${packPath}`);
    return 1;
  }
  const publicKeyPem = io.readText(pubkeyPath);

  if (!verifyOnboardingPack(pack, publicKeyPem)) {
    io.log('✗ signature INVALID — refusing to apply (possible tampering or wrong key)');
    return 1;
  }
  io.log(`✓ signature valid — pack for ${pack.manifest.agent} (issued ${pack.manifest.issuedAt})`);

  if (cmd === 'verify') return 0;

  // init: write the verified client config.
  const out = flag(argv, 'out') ?? pack.manifest.config.path;
  io.writeText(out, pack.manifest.config.content);
  io.log(`wrote ${pack.manifest.agent} config → ${out}`);
  for (const note of pack.manifest.config.notes) io.log(`  • ${note}`);
  return 0;
}

/* c8 ignore start — thin process wrapper (the logic above is what's tested). */
if (process.argv[1] && /onboarding-cli\.(ts|js)$/.test(process.argv[1])) {
  const io: CliIo = {
    readText: (p) => readFileSync(p, 'utf8'),
    writeText: (p, c) => writeFileSync(p, c),
    log: (l) => process.stdout.write(`${l}\n`),
  };
  process.exit(runOnboardingCli(process.argv.slice(2), io));
}
/* c8 ignore stop */
