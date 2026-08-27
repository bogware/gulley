import {
  type AppliedDiff,
  type ConfigDocument,
  type ConfigEntity,
  type ConfigProvider,
  type ConfigStore,
  type ConfigWorkspace,
  diffDocuments,
  type ReconcileContext,
} from '@gulley/config';
import type { CollectionKind, Workspace } from './domain';
import type { ControlContext } from './context';

const DOC_TO_KIND: Array<[keyof ConfigWorkspace, CollectionKind]> = [
  ['routes', 'route'],
  ['policies', 'policy'],
  ['budgets', 'budget'],
  ['rateLimits', 'ratelimit'],
  ['guardrails', 'guardrail'],
  ['modelAliases', 'modelalias'],
  ['smartRoutingPolicies', 'smartroutingpolicy'],
];

const byName = <T extends { name: string }>(a: T, b: T): number => a.name.localeCompare(b.name);

/** ConfigStore over the control-api's in-memory stores. Export is deterministic
 *  (sorted) so content hashes are stable. Reconcile upserts within authorized
 *  orgs and NEVER touches virtual keys (they are export-only metadata). */
export class ControlConfigStore implements ConfigStore {
  constructor(private readonly ctx: ControlContext) {}

  private exportWorkspace(ws: Workspace): ConfigWorkspace {
    const providers: ConfigProvider[] = this.ctx.providers
      .all()
      .filter((p) => p.workspaceId === ws.id)
      .sort((a, b) => a.kind.localeCompare(b.kind))
      .map((p) => {
        const cred = this.ctx.credentials.get(p.id);
        const provider: ConfigProvider = {
          kind: p.kind,
          baseUrl: p.baseUrl ?? null,
          enabled: p.enabled,
        };
        if (cred) provider.credential = cred.credential;
        return provider;
      });
    const coll = (kind: CollectionKind): ConfigEntity[] =>
      this.ctx.collections[kind]
        .all()
        .filter((e) => e.workspaceId === ws.id)
        .sort(byName)
        .map((e) => ({ name: e.name, config: e.config }));
    const virtualKeys = this.ctx.keys
      .all()
      .filter((k) => k.workspaceId === ws.id)
      .sort(byName)
      .map((k) => ({ name: k.name, keyPrefix: k.keyPrefix, disabled: k.disabled }));
    const out: ConfigWorkspace = {
      name: ws.name,
      providers,
      routes: coll('route'),
      policies: coll('policy'),
      budgets: coll('budget'),
      rateLimits: coll('ratelimit'),
      guardrails: coll('guardrail'),
      modelAliases: coll('modelalias'),
      virtualKeys,
    };
    // Optional collection: emit only when non-empty (absence ≡ empty) so existing
    // content hashes and drift are unaffected.
    const smartRoutingPolicies = coll('smartroutingpolicy');
    if (smartRoutingPolicies.length > 0) out.smartRoutingPolicies = smartRoutingPolicies;
    return out;
  }

  async exportDocument(orgIds: ReadonlySet<string> | '*'): Promise<ConfigDocument> {
    const ids = orgIds === '*' ? '*' : [...orgIds];
    const orgs = this.ctx.orgs.list(ids).sort(byName);
    return {
      apiVersion: 'gulley/v1',
      orgs: orgs.map((org) => ({
        name: org.name,
        workspaces: this.ctx.workspaces
          .list('*')
          .filter((w) => w.orgId === org.id)
          .sort(byName)
          .map((ws) => this.exportWorkspace(ws)),
      })),
    };
  }

  async authorize(desired: ConfigDocument, cx: ReconcileContext): Promise<boolean> {
    const current = this.ctx.orgs.list('*');
    // First-match by name, matching reconcile()'s `.find(...)`, so a duplicate
    // org name can't authorize one org while reconcile mutates another.
    const idByName = new Map<string, string>();
    for (const o of current) if (!idByName.has(o.name)) idByName.set(o.name, o.id);
    const affected = new Set<string>([
      ...desired.orgs.map((o) => o.name),
      ...current.filter((o) => !desired.orgs.some((d) => d.name === o.name)).map((o) => o.name),
    ]);
    for (const name of affected) {
      const orgId = idByName.get(name);
      const at = orgId ? { orgId } : {};
      if (!(await cx.access.can(cx.admin, 'config:apply', at))) return false;
    }
    return true;
  }

  async reconcile(desired: ConfigDocument): Promise<AppliedDiff> {
    const before = await this.exportDocument('*');
    for (const dOrg of desired.orgs) {
      const org =
        this.ctx.orgs.list('*').find((o) => o.name === dOrg.name) ??
        this.ctx.orgs.create(dOrg.name);
      for (const dWs of dOrg.workspaces) {
        const ws =
          this.ctx.workspaces.list('*').find((w) => w.orgId === org.id && w.name === dWs.name) ??
          this.ctx.workspaces.create(org.id, dWs.name);

        for (const dp of dWs.providers) {
          const exists = this.ctx.providers
            .all()
            .some((p) => p.workspaceId === ws.id && p.kind === dp.kind);
          if (!exists) {
            this.ctx.providers.create({
              workspaceId: ws.id,
              kind: dp.kind,
              baseUrl: dp.baseUrl ?? null,
              enabled: dp.enabled,
            });
          }
        }

        for (const [docKey, kind] of DOC_TO_KIND) {
          // Optional collections (e.g. smartRoutingPolicies) may be absent ⇒ [].
          const desiredEntities = (dWs[docKey] ?? []) as ConfigEntity[];
          const coll = this.ctx.collections[kind];
          const desiredNames = new Set(desiredEntities.map((e) => e.name));
          for (const e of coll.all().filter((x) => x.workspaceId === ws.id)) {
            if (!desiredNames.has(e.name)) coll.delete(e.id); // delete-by-absence (entities only)
          }
          for (const de of desiredEntities) {
            const cur = coll.all().find((x) => x.workspaceId === ws.id && x.name === de.name);
            if (!cur) coll.create(ws.id, de.name, de.config);
            else if (JSON.stringify(cur.config) !== JSON.stringify(de.config)) {
              coll.update(cur.id, { config: de.config });
            }
          }
        }
        // virtual keys: intentionally untouched.
      }
    }
    const after = await this.exportDocument('*');
    return { summary: diffDocuments(before, after) };
  }
}
