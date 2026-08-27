import { describe, expect, it } from 'vitest';
import { isErr, isOk } from '@gulley/core';
import { InMemoryKeyStore, type StoredKey } from './key-store';
import { scopeGroups } from './principal';
import { resolveVirtualKey } from './resolver';
import { generateVirtualKey, parseVirtualKey, verifySecret } from './virtual-key';

const PEPPER = 'test-pepper';

function seed(store: InMemoryKeyStore, overrides: Partial<StoredKey> = {}): string {
  const gen = generateVirtualKey(PEPPER);
  store.add({
    id: 'vk_1',
    keyPrefix: gen.keyPrefix,
    keyHash: gen.keyHash,
    orgId: 'org_1',
    workspaceId: 'ws_1',
    displayName: 'CI key',
    epoch: 0,
    disabled: false,
    expiresAt: null,
    allowedProviders: '*',
    allowedModels: '*',
    ...overrides,
  });
  return gen.token;
}

describe('virtual key', () => {
  it('round-trips generate -> parse -> verify', () => {
    const gen = generateVirtualKey(PEPPER);
    const parsed = parseVirtualKey(gen.token);
    expect(parsed).not.toBeNull();
    expect(parsed?.keyPrefix).toBe(gen.keyPrefix);
    expect(verifySecret(PEPPER, parsed!.secret, gen.keyHash)).toBe(true);
  });

  it('rejects a tampered secret and a wrong pepper', () => {
    const gen = generateVirtualKey(PEPPER);
    const parsed = parseVirtualKey(gen.token)!;
    expect(verifySecret(PEPPER, `${parsed.secret}x`, gen.keyHash)).toBe(false);
    expect(verifySecret('other-pepper', parsed.secret, gen.keyHash)).toBe(false);
  });

  it('parses null for non-keys', () => {
    expect(parseVirtualKey('sk-ant-123')).toBeNull();
    expect(parseVirtualKey('gk_short')).toBeNull();
  });
});

describe('resolveVirtualKey', () => {
  it('resolves a valid key on the x-api-key channel', async () => {
    const store = new InMemoryKeyStore();
    const token = seed(store);
    const r = await resolveVirtualKey({ apiKey: token }, { keyStore: store, pepper: PEPPER });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.scope.workspaceId).toBe('ws_1');
      expect(r.value.authMode).toBe('virtual-key');
    }
    expect(store.lastUsed.has('vk_1')).toBe(true);
  });

  it('resolves the same key on the bearer channel', async () => {
    const store = new InMemoryKeyStore();
    const token = seed(store);
    const r = await resolveVirtualKey({ bearer: token }, { keyStore: store, pepper: PEPPER });
    expect(isOk(r)).toBe(true);
  });

  it('fails closed on missing, unknown, disabled, and expired keys', async () => {
    const store = new InMemoryKeyStore();
    const good = seed(store);

    expect(isErr(await resolveVirtualKey({}, { keyStore: store, pepper: PEPPER }))).toBe(true);

    const unknown = generateVirtualKey(PEPPER).token;
    expect(
      isErr(await resolveVirtualKey({ apiKey: unknown }, { keyStore: store, pepper: PEPPER })),
    ).toBe(true);

    const disabledStore = new InMemoryKeyStore();
    const disabledTok = seed(disabledStore, { disabled: true });
    expect(
      isErr(
        await resolveVirtualKey(
          { apiKey: disabledTok },
          { keyStore: disabledStore, pepper: PEPPER },
        ),
      ),
    ).toBe(true);

    const expStore = new InMemoryKeyStore();
    const expTok = seed(expStore, { expiresAt: new Date(1000) });
    const expResult = await resolveVirtualKey(
      { apiKey: expTok },
      { keyStore: expStore, pepper: PEPPER, now: () => 2000 },
    );
    expect(isErr(expResult)).toBe(true);

    // Control: the good key still resolves.
    expect(
      isOk(await resolveVirtualKey({ apiKey: good }, { keyStore: store, pepper: PEPPER })),
    ).toBe(true);
  });

  it('carries the key group tags onto the scope, and defaults to none', async () => {
    const tagged = new InMemoryKeyStore();
    const taggedTok = seed(tagged, { groups: ['eng', 'beta'] });
    const r = await resolveVirtualKey({ apiKey: taggedTok }, { keyStore: tagged, pepper: PEPPER });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(scopeGroups(r.value.scope)).toEqual(['eng', 'beta']);

    const plain = new InMemoryKeyStore();
    const plainTok = seed(plain);
    const r2 = await resolveVirtualKey({ apiKey: plainTok }, { keyStore: plain, pepper: PEPPER });
    expect(isOk(r2)).toBe(true);
    if (isOk(r2)) expect(scopeGroups(r2.value.scope)).toEqual([]);
  });

  it('does not fall through to another mode when the secret is wrong', async () => {
    const store = new InMemoryKeyStore();
    const token = seed(store);
    const tampered = `${token}tampered`;
    const r = await resolveVirtualKey({ apiKey: tampered }, { keyStore: store, pepper: PEPPER });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe('bad_secret');
  });
});
