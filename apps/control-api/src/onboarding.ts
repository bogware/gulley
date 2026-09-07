import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import {
  type ClientAgent,
  generateClientConfig,
  type GeneratedClientConfig,
} from './client-config';

/**
 * Signed onboarding packs — the turnkey, TAMPER-EVIDENT bootstrap a developer runs
 * (`gulley codex|claude-code init`). An admin generates a pack (client config from
 * the model policy, #6) SIGNED with the org's Ed25519 key; the developer's CLI
 * verifies the signature against the org's published public key before writing any
 * config, so a phished/tampered pack (wrong gateway URL, injected settings) is
 * rejected. Signing + verification are pure + unit-tested here; the CLI and the
 * control-api endpoint are thin wrappers.
 */

export interface OnboardingManifest {
  agent: ClientAgent;
  gatewayUrl: string;
  allowedModels: string[];
  /** Who/what the pack was issued for (workspace / team), for traceability. */
  issuedFor: string;
  issuedAt: string;
  config: GeneratedClientConfig;
}

export interface OnboardingPack {
  manifest: OnboardingManifest;
  alg: 'ed25519';
  /** Base64 detached signature over the canonical manifest. */
  signature: string;
}

/** Deterministic JSON (recursively key-sorted) so the signer and verifier hash the
 *  exact same bytes regardless of property insertion order. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export interface BuildPackInput {
  agent: ClientAgent;
  gatewayUrl: string;
  allowedModels?: string[];
  issuedFor: string;
  issuedAt: string;
  keyPrefix?: string;
}

export function buildOnboardingManifest(input: BuildPackInput): OnboardingManifest {
  const config = generateClientConfig({
    agent: input.agent,
    gatewayUrl: input.gatewayUrl,
    allowedModels: input.allowedModels,
    keyPrefix: input.keyPrefix,
  });
  return {
    agent: input.agent,
    gatewayUrl: input.gatewayUrl,
    allowedModels: input.allowedModels ?? [],
    issuedFor: input.issuedFor,
    issuedAt: input.issuedAt,
    config,
  };
}

/** Sign a manifest with an Ed25519 private key (PEM). Ed25519 uses a null digest
 *  algorithm (the whole message is signed). */
export function signOnboardingPack(
  manifest: OnboardingManifest,
  privateKeyPem: string,
): OnboardingPack {
  const key = createPrivateKey(privateKeyPem);
  const sig = sign(null, Buffer.from(canonicalize(manifest), 'utf8'), key);
  return { manifest, alg: 'ed25519', signature: sig.toString('base64') };
}

/** Verify a pack against an Ed25519 public key (PEM). False (never throws) on any
 *  mismatch, bad key, or wrong algorithm — a tampered manifest fails closed. */
export function verifyOnboardingPack(pack: OnboardingPack, publicKeyPem: string): boolean {
  if (pack.alg !== 'ed25519' || typeof pack.signature !== 'string') return false;
  try {
    return verify(
      null,
      Buffer.from(canonicalize(pack.manifest), 'utf8'),
      createPublicKey(publicKeyPem),
      Buffer.from(pack.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/** Derive the PEM public key from an Ed25519 private key PEM (served so a verifier
 *  can fetch the org's key out-of-band). */
export function publicKeyOf(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem))
    .export({ type: 'spki', format: 'pem' })
    .toString();
}
