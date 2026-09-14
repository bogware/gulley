import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type CliIo, runCli } from './cli';
import {
  buildOnboardingManifest,
  canonicalize,
  publicKeyOf,
  signOnboardingPack,
  verifyOnboardingPack,
} from './onboarding';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const manifest = () =>
  buildOnboardingManifest({
    agent: 'claude-code',
    gatewayUrl: 'https://gulley.acme.internal',
    allowedModels: ['claude-*'],
    issuedFor: 'ws-prod',
    issuedAt: '2026-09-07T12:00:00.000Z',
    keyPrefix: 'gk_ab',
  });

describe('canonicalize', () => {
  it('is order-independent (key-sorted, recursive)', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalize({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(canonicalize({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });
});

describe('onboarding pack sign/verify', () => {
  it('signs and verifies a valid pack', () => {
    const pack = signOnboardingPack(manifest(), privPem);
    expect(pack.alg).toBe('ed25519');
    expect(verifyOnboardingPack(pack, pubPem)).toBe(true);
    // publicKeyOf derives the same key the org would publish.
    expect(verifyOnboardingPack(pack, publicKeyOf(privPem))).toBe(true);
  });

  it('rejects a tampered manifest (e.g. a swapped gateway URL)', () => {
    const pack = signOnboardingPack(manifest(), privPem);
    const tampered = {
      ...pack,
      manifest: { ...pack.manifest, gatewayUrl: 'https://evil.example.com' },
    };
    expect(verifyOnboardingPack(tampered, pubPem)).toBe(false);
  });

  it('rejects a signature from a different key and a wrong algorithm', () => {
    const pack = signOnboardingPack(manifest(), privPem);
    const other = generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    expect(verifyOnboardingPack(pack, other)).toBe(false);
    expect(verifyOnboardingPack({ ...pack, alg: 'rs256' as never }, pubPem)).toBe(false);
    expect(verifyOnboardingPack({ ...pack, signature: 'not-base64!!' }, pubPem)).toBe(false);
  });

  it('embeds the generated client config in the manifest', () => {
    const m = manifest();
    expect(m.config.path).toBe('.claude/settings.json');
    expect(m.config.content).toContain('https://gulley.acme.internal');
  });
});

describe('gulley verify / init (signed onboarding packs)', () => {
  function fakeIo(files: Record<string, string>): {
    io: CliIo;
    logs: string[];
    writes: Record<string, string>;
  } {
    const logs: string[] = [];
    const writes: Record<string, string> = {};
    const io: CliIo = {
      readText: (p) => writes[p] ?? files[p],
      writeText: (p, c) => {
        writes[p] = c;
      },
      deleteFile: () => undefined,
      log: (l) => logs.push(l),
      error: (l) => logs.push(l),
      fetch: () => Promise.reject(new Error('no network in this test')),
      sleep: () => Promise.resolve(),
      now: () => 0,
      homeDir: '/home/dev',
      env: {},
      lock: async () => () => undefined,
    };
    return { io, logs, writes };
  }

  it('verify: 0 for a valid pack, 1 for a tampered one', async () => {
    const pack = signOnboardingPack(manifest(), privPem);
    const ok = fakeIo({ 'pack.json': JSON.stringify(pack), 'key.pem': pubPem });
    expect(await runCli(['verify', 'pack.json', '--pubkey', 'key.pem'], ok.io)).toBe(0);
    expect(ok.logs.join(' ')).toContain('signature valid');

    const tampered = { ...pack, manifest: { ...pack.manifest, gatewayUrl: 'https://evil' } };
    const bad = fakeIo({ 'pack.json': JSON.stringify(tampered), 'key.pem': pubPem });
    expect(await runCli(['verify', 'pack.json', '--pubkey', 'key.pem'], bad.io)).toBe(1);
    expect(bad.logs.join(' ')).toContain('INVALID');
  });

  it('init: writes the verified config (and unwraps a { pack } response)', async () => {
    const pack = signOnboardingPack(manifest(), privPem);
    const f = fakeIo({ 'pack.json': JSON.stringify({ pack }), 'key.pem': pubPem });
    const code = await runCli(
      ['init', 'pack.json', '--pubkey', 'key.pem', '--out', 'out.json'],
      f.io,
    );
    expect(code).toBe(0);
    expect(f.writes['out.json']).toContain('https://gulley.acme.internal');
  });

  it('init: merges into an existing settings.json instead of clobbering it', async () => {
    const pack = signOnboardingPack(manifest(), privPem);
    const f = fakeIo({
      'pack.json': JSON.stringify(pack),
      'key.pem': pubPem,
      '.claude/settings.json': JSON.stringify({
        permissions: { allow: ['Read'] },
        env: { A: '1' },
      }),
    });
    expect(await runCli(['init', 'pack.json', '--pubkey', 'key.pem'], f.io)).toBe(0);
    const merged = JSON.parse(f.writes['.claude/settings.json']!) as Record<string, unknown>;
    expect(merged['permissions']).toEqual({ allow: ['Read'] });
    expect(merged['env']).toMatchObject({
      A: '1',
      ANTHROPIC_BASE_URL: 'https://gulley.acme.internal',
    });
  });

  it('refuses without a --pubkey and with a bad command', async () => {
    const f = fakeIo({ 'pack.json': '{}' });
    expect(await runCli(['verify', 'pack.json'], f.io)).toBe(2); // no pubkey
    expect(await runCli(['bogus'], f.io)).toBe(2);
  });
});
