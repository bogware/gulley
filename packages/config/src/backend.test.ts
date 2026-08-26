import { secretRef } from '@gulley/core';
import type { AccessControl, AdminPrincipal } from '@gulley/rbac';
import { describe, expect, it } from 'vitest';
import { authorizeWithBackend, BackendConfigStore, InMemoryConfigBackend } from './backend';
import { contentHash } from './canonical';
import type { ConfigDocument } from './document';

const ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:anthropic-abc';
const admin = { subject: 'admin' } as unknown as AdminPrincipal;
const allow: AccessControl = { can: async () => true };
const deny: AccessControl = { can: async () => false };

const doc = (
  over: Partial<ConfigDocument['orgs'][number]['workspaces'][number]> = {},
): ConfigDocument => ({
  apiVersion: 'gulley/v1',
  orgs: [
    {
      name: 'Acme',
      workspaces: [
        {
          name: 'prod',
          providers: [
            {
              kind: 'anthropic',
              baseUrl: 'https://api.anthropic.com',
              enabled: true,
              credential: secretRef(ARN, 'v1'),
            },
          ],
          routes: [{ name: 'default', config: { strategy: 'single' } }],
          policies: [],
          budgets: [{ name: 'default', config: { capMicroUsd: 1_000_000 } }],
          rateLimits: [],
          guardrails: [],
          modelAliases: [],
          virtualKeys: [],
          ...over,
        },
      ],
    },
  ],
});

describe('reconcileWithBackend + exportWithBackend', () => {
  it('round-trips a document (reconcile → export has the same content hash)', async () => {
    const store = new BackendConfigStore(new InMemoryConfigBackend());
    const d = doc();
    await store.reconcile(d, { admin, access: allow });
    const exported = await store.exportDocument('*');
    expect(contentHash(exported)).toBe(contentHash(d));
    // The credential survives as an ARN reference.
    expect(exported.orgs[0]?.workspaces[0]?.providers[0]?.credential).toMatchObject({
      secretArn: ARN,
      secretVersion: 'v1',
    });
  });

  it('upserts changes and prunes by absence on a second apply', async () => {
    const backend = new InMemoryConfigBackend();
    const store = new BackendConfigStore(backend);
    await store.reconcile(doc(), { admin, access: allow });

    // Change the route config, add a guardrail, drop the provider entirely.
    await store.reconcile(
      doc({
        providers: [],
        routes: [{ name: 'default', config: { strategy: 'fallback' } }],
        guardrails: [{ name: 'g', config: { action: 'block' } }],
      }),
      { admin, access: allow },
    );

    const ws = (await store.exportDocument('*')).orgs[0]?.workspaces[0];
    expect(ws?.providers).toHaveLength(0); // provider pruned
    expect(ws?.routes[0]?.config).toEqual({ strategy: 'fallback' }); // updated
    expect(ws?.guardrails[0]?.name).toBe('g'); // created
    // The pruned provider's credential is gone too.
    expect(await backend.getCredential('id_3')).toBeNull();
  });

  it('does not create duplicate orgs/workspaces across repeated applies', async () => {
    const backend = new InMemoryConfigBackend();
    const store = new BackendConfigStore(backend);
    await store.reconcile(doc(), { admin, access: allow });
    await store.reconcile(doc(), { admin, access: allow });
    expect(await backend.listOrgs()).toHaveLength(1);
  });

  it('authorize denies when the admin lacks config:apply', async () => {
    const backend = new InMemoryConfigBackend();
    expect(await authorizeWithBackend(backend, doc(), { admin, access: allow })).toBe(true);
    expect(await authorizeWithBackend(backend, doc(), { admin, access: deny })).toBe(false);
  });
});
