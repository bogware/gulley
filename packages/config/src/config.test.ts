import { InMemoryAuditSink } from '@gulley/pipeline';
import { type AdminPrincipal, InMemoryAccessControl } from '@gulley/rbac';
import { describe, expect, it } from 'vitest';
import { applyConfig } from './apply';
import { contentHash, diffDocuments } from './canonical';
import { type ConfigDocument, emptyDocument } from './document';
import { type ConfigStore, InMemoryConfigVersionStore, type ReconcileContext } from './store';
import { fromYaml, toYaml } from './yaml';

const OWNER: AdminPrincipal = {
  kind: 'admin',
  subject: 'owner',
  displayName: 'Owner',
  source: 'bootstrap',
  memberships: [{ role: 'owner', orgId: '*' }],
};

function doc(routeConfig: Record<string, unknown> = { model: 'haiku' }): ConfigDocument {
  return {
    apiVersion: 'gulley/v1',
    orgs: [
      {
        name: 'Acme',
        workspaces: [
          {
            name: 'Default',
            providers: [{ kind: 'anthropic', baseUrl: 'https://api.anthropic.com', enabled: true }],
            routes: [{ name: 'default', config: routeConfig }],
            policies: [],
            budgets: [],
            rateLimits: [],
            guardrails: [],
            modelAliases: [],
            virtualKeys: [],
          },
        ],
      },
    ],
  };
}

class TestStore implements ConfigStore {
  constructor(public current: ConfigDocument = emptyDocument()) {}
  async exportDocument(): Promise<ConfigDocument> {
    return JSON.parse(JSON.stringify(this.current)) as ConfigDocument;
  }
  async authorize(_d: ConfigDocument, _cx: ReconcileContext): Promise<boolean> {
    return true;
  }
  async reconcile(
    desired: ConfigDocument,
  ): Promise<{ summary: { added: string[]; removed: string[]; changed: string[] } }> {
    this.current = JSON.parse(JSON.stringify(desired)) as ConfigDocument;
    return { summary: { added: [], removed: [], changed: [] } };
  }
}

function deps(store: TestStore, versions = new InMemoryConfigVersionStore()) {
  return { store, versions, audit: new InMemoryAuditSink(), access: new InMemoryAccessControl() };
}

describe('canonical + diff', () => {
  it('contentHash is stable under key reordering', () => {
    const a = { apiVersion: 'gulley/v1', orgs: [{ name: 'x', workspaces: [] }] } as ConfigDocument;
    const b = { orgs: [{ workspaces: [], name: 'x' }], apiVersion: 'gulley/v1' } as ConfigDocument;
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it('diff reports a changed route config path', () => {
    const d = diffDocuments(doc({ model: 'haiku' }), doc({ model: 'sonnet' }));
    expect(d.changed.some((p) => p.includes('model'))).toBe(true);
  });
});

describe('yaml', () => {
  it('round-trips and refuses inline secrets', () => {
    const y = toYaml(doc());
    const parsed = fromYaml(y);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(contentHash(parsed.value)).toBe(contentHash(doc()));
    expect(() => toYaml(doc({ keyHash: 'a'.repeat(64) }))).toThrow();
  });
});

describe('applyConfig', () => {
  it('applies, bumps the version, and round-trips content', async () => {
    const store = new TestStore();
    const d = deps(store);
    const r = await applyConfig(doc(), 0, OWNER, d);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.version).toBe(1);
      expect(contentHash(await store.exportDocument())).toBe(r.value.contentHash);
    }
  });

  it('rejects a stale baseVersion (409)', async () => {
    const store = new TestStore();
    const d = deps(store);
    await applyConfig(doc(), 0, OWNER, d);
    const stale = await applyConfig(doc({ model: 'x' }), 0, OWNER, d);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.kind).toBe('stale');
  });

  it('rejects inline secrets and blocked egress', async () => {
    const secret = await applyConfig(
      doc({ apiKey: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAA' }),
      0,
      OWNER,
      deps(new TestStore()),
    );
    expect(secret.ok).toBe(false);
    if (!secret.ok) expect(secret.error.kind).toBe('inline_secret');

    const bad = doc();
    bad.orgs[0]!.workspaces[0]!.providers[0]!.baseUrl = 'http://169.254.169.254/';
    const egress = await applyConfig(bad, 0, OWNER, deps(new TestStore()));
    expect(egress.ok).toBe(false);
    if (!egress.ok) expect(egress.error.kind).toBe('egress');
  });

  it('serializes concurrent applies at the same base version', async () => {
    const d = deps(new TestStore());
    const [a, b] = await Promise.all([
      applyConfig(doc(), 0, OWNER, d),
      applyConfig(doc(), 0, OWNER, d),
    ]);
    expect([a.ok, b.ok].filter(Boolean).length).toBe(1);
  });
});
