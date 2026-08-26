import type { UpstreamCredential } from '@gulley/providers';
import { describe, expect, it } from 'vitest';
import { credentialFor, MapTenantCredentialResolver } from './tenant';

describe('credentialFor', () => {
  it('picks the scheme per provider', () => {
    expect(credentialFor('anthropic', 'sk-ant-x')).toEqual({
      scheme: 'x-api-key',
      value: 'sk-ant-x',
    });
    expect(credentialFor('anthropic', 'oauth')).toEqual({ scheme: 'bearer', value: 'oauth' });
    expect(credentialFor('azure', 'k')).toEqual({ scheme: 'api-key', value: 'k' });
    expect(credentialFor('openai', 'k')).toEqual({ scheme: 'bearer', value: 'k' });
  });
});

describe('MapTenantCredentialResolver', () => {
  it('resolves a tenant credential by workspace + provider, else undefined', async () => {
    const cred: UpstreamCredential = { scheme: 'x-api-key', value: 'tenant-a-key' };
    const r = new MapTenantCredentialResolver(new Map([['ws_a', new Map([['anthropic', cred]])]]));
    expect(await r.resolve('ws_a', 'anthropic')).toBe(cred);
    expect(await r.resolve('ws_a', 'openai')).toBeUndefined(); // no per-tenant openai key
    expect(await r.resolve('ws_b', 'anthropic')).toBeUndefined(); // different tenant
  });
});
