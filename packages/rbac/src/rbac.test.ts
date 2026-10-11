import { describe, expect, it } from 'vitest';
import { InMemoryAccessControl, RoleAwareAccessControl } from './access-control';
import {
  can,
  canAnywhere,
  canGrant,
  covers,
  coveredOrgIds,
  coversWorkspace,
  effectivePermissionsAt,
} from './engine';
import {
  ALL_PERMISSIONS,
  isPermission,
  PERMISSIONS_BY_ROLE,
  permissionResource,
} from './permissions';
import type { AdminPrincipal } from './principal';
import { isRole, isRoleId, ROLES } from './principal';
import {
  BUILTIN_ROLES,
  builtinRoleResolver,
  permissionsOf,
  type RoleDefinition,
  StaticRoleResolver,
} from './roles';

function principal(memberships: AdminPrincipal['memberships']): AdminPrincipal {
  return { kind: 'admin', subject: 's', displayName: 'd', source: 'session', memberships };
}

describe('covers', () => {
  it('org membership covers any workspace in that org, not other orgs', () => {
    const m = { role: 'editor', orgId: 'o1' } as const;
    expect(covers(m, { orgId: 'o1', workspaceId: 'w1' })).toBe(true);
    expect(covers(m, { orgId: 'o1' })).toBe(true);
    expect(covers(m, { orgId: 'o2' })).toBe(false);
  });

  it('workspace membership does not cover the whole org', () => {
    const m = { role: 'editor', orgId: 'o1', workspaceId: 'w1' } as const;
    expect(covers(m, { orgId: 'o1', workspaceId: 'w1' })).toBe(true);
    expect(covers(m, { orgId: 'o1', workspaceId: 'w2' })).toBe(false);
    expect(covers(m, { orgId: 'o1' })).toBe(false); // org-wide scope not covered
  });

  it('the * sentinel covers everything, including an empty scope', () => {
    const m = { role: 'owner', orgId: '*' } as const;
    expect(covers(m, {})).toBe(true);
    expect(covers(m, { orgId: 'anything' })).toBe(true);
  });
});

describe('built-in roles (unchanged permission sets)', () => {
  const viewer = principal([{ role: 'viewer', orgId: 'o1' }]);
  const editor = principal([{ role: 'editor', orgId: 'o1' }]);
  const owner = principal([{ role: 'owner', orgId: 'o1' }]);

  it('viewer can read but not write', () => {
    expect(can(viewer, 'org:read', { orgId: 'o1' })).toBe(true);
    expect(can(viewer, 'role:read', { orgId: 'o1' })).toBe(true);
    expect(can(viewer, 'workspace:create', { orgId: 'o1' })).toBe(false);
  });

  it('editor can write in-scope but not out-of-scope', () => {
    expect(can(editor, 'workspace:create', { orgId: 'o1' })).toBe(true);
    expect(can(editor, 'workspace:create', { orgId: 'o2' })).toBe(false);
  });

  it('only owner may grant owner or apply config', () => {
    const admin = principal([{ role: 'admin', orgId: 'o1' }]);
    expect(can(admin, 'membership:grant_owner', { orgId: 'o1' })).toBe(false);
    expect(can(admin, 'config:apply', { orgId: 'o1' })).toBe(false);
    expect(can(owner, 'membership:grant_owner', { orgId: 'o1' })).toBe(true);
    expect(can(owner, 'config:apply', { orgId: 'o1' })).toBe(true);
  });

  it('roles strictly nest (owner ⊇ admin ⊇ editor ⊇ billing ⊇ viewer)', () => {
    const chain = ['viewer', 'billing', 'editor', 'admin', 'owner'] as const;
    for (let i = 1; i < chain.length; i++) {
      for (const p of PERMISSIONS_BY_ROLE[chain[i - 1]!])
        expect(PERMISSIONS_BY_ROLE[chain[i]!].has(p)).toBe(true);
    }
  });

  it('key lifecycle verbs are distinct from minting and held by editor+', () => {
    expect(PERMISSIONS_BY_ROLE.viewer.has('key:disable')).toBe(false);
    expect(PERMISSIONS_BY_ROLE.billing.has('key:rotate')).toBe(false);
    for (const r of ['editor', 'admin', 'owner'] as const) {
      expect(PERMISSIONS_BY_ROLE[r].has('key:disable')).toBe(true);
      expect(PERMISSIONS_BY_ROLE[r].has('key:rotate')).toBe(true);
      expect(PERMISSIONS_BY_ROLE[r].has('key:create')).toBe(true);
    }
  });

  it('role management is admin+ while role:read is universal', () => {
    for (const r of ROLES) expect(PERMISSIONS_BY_ROLE[r].has('role:read')).toBe(true);
    expect(PERMISSIONS_BY_ROLE.editor.has('role:create')).toBe(false);
    expect(PERMISSIONS_BY_ROLE.admin.has('role:create')).toBe(true);
    expect(PERMISSIONS_BY_ROLE.admin.has('role:update')).toBe(true);
    expect(PERMISSIONS_BY_ROLE.admin.has('role:delete')).toBe(true);
  });

  it('the seeded definitions mirror PERMISSIONS_BY_ROLE and are flagged builtin', () => {
    expect(BUILTIN_ROLES.map((r) => r.id)).toEqual([...ROLES]);
    for (const def of BUILTIN_ROLES) {
      expect(def.builtin).toBe(true);
      expect(def.name).toBe(def.id);
      expect(new Set(def.permissions)).toEqual(PERMISSIONS_BY_ROLE[def.id as 'owner']);
      expect(builtinRoleResolver.get(def.id)).toBe(def);
    }
    expect(builtinRoleResolver.get('custom')).toBeUndefined();
  });

  it('ALL_PERMISSIONS is the owner set and isPermission validates against it', () => {
    expect(new Set(ALL_PERMISSIONS)).toEqual(PERMISSIONS_BY_ROLE.owner);
    expect(isPermission('key:disable')).toBe(true);
    expect(isPermission('org:update')).toBe(false); // nobody holds it → not grantable
    expect(isPermission('nope')).toBe(false);
    expect(permissionResource('membership:grant_owner')).toBe('membership');
  });

  it('isRole accepts built-in names only; isRoleId accepts well-formed ids', () => {
    expect(isRole('owner')).toBe(true);
    expect(isRole('key-operator')).toBe(false);
    expect(isRoleId('key-operator')).toBe(true);
    expect(isRoleId('owner')).toBe(true);
    expect(isRoleId('Bad Role')).toBe(false);
    expect(isRoleId('')).toBe(false);
    expect(isRoleId(42)).toBe(false);
  });
});

describe('custom roles', () => {
  const keyOperator: RoleDefinition = {
    id: 'key-operator',
    name: 'Key operator',
    permissions: ['key:read', 'key:disable', 'key:rotate'],
    builtin: false,
  };
  const resolver = new StaticRoleResolver([keyOperator]);
  const op = principal([{ role: 'key-operator', orgId: 'o1' }]);

  it('grant exactly their permission set through the resolver', () => {
    expect(can(op, 'key:disable', { orgId: 'o1' }, resolver)).toBe(true);
    expect(can(op, 'key:rotate', { orgId: 'o1' }, resolver)).toBe(true);
    expect(can(op, 'key:create', { orgId: 'o1' }, resolver)).toBe(false);
    expect(can(op, 'key:disable', { orgId: 'o2' }, resolver)).toBe(false); // scope still applies
  });

  it('an unknown role id (or no resolver) grants nothing and never throws', () => {
    expect(can(op, 'key:disable', { orgId: 'o1' })).toBe(false);
    const ghost = principal([{ role: 'deleted-role', orgId: 'o1' }]);
    expect(can(ghost, 'org:read', { orgId: 'o1' }, resolver)).toBe(false);
    expect(permissionsOf('deleted-role', resolver).size).toBe(0);
    const throwing = {
      get: () => {
        throw new Error('boom');
      },
    };
    expect(can(ghost, 'org:read', { orgId: 'o1' }, throwing)).toBe(false);
  });

  it('a stored definition can never redefine a built-in', () => {
    const r = new StaticRoleResolver([
      { id: 'viewer', name: 'viewer', permissions: ['org:delete'], builtin: false },
    ]);
    expect(permissionsOf('viewer', r).has('org:delete')).toBe(false);
    expect(r.get('viewer')?.builtin).toBe(true);
  });

  it('effectivePermissionsAt unions covering memberships', () => {
    const p = principal([
      { role: 'viewer', orgId: 'o1' },
      { role: 'key-operator', orgId: 'o1', workspaceId: 'w1' },
    ]);
    expect(effectivePermissionsAt(p, { orgId: 'o1' }, resolver).has('key:rotate')).toBe(false);
    const atWs = effectivePermissionsAt(p, { orgId: 'o1', workspaceId: 'w1' }, resolver);
    expect(atWs.has('key:rotate')).toBe(true);
    expect(atWs.has('org:read')).toBe(true);
  });

  it('canAnywhere finds a permission at any scope (reads only)', () => {
    expect(canAnywhere(op, 'key:disable', resolver)).toBe(true);
    expect(canAnywhere(op, 'key:create', resolver)).toBe(false);
  });
});

describe('canGrant (subset anti-amplification)', () => {
  const resolver = new StaticRoleResolver([
    { id: 'key-operator', name: 'k', permissions: ['key:read', 'key:disable'], builtin: false },
    {
      id: 'super',
      name: 's',
      permissions: ['key:read', 'guardrail:reveal'],
      builtin: false,
    },
    { id: 'empty', name: 'e', permissions: [], builtin: false },
  ]);

  it('built-ins keep their ordering: a role is grantable only by a superset holder', () => {
    const admin = principal([{ role: 'admin', orgId: 'o1' }]);
    const owner = principal([{ role: 'owner', orgId: 'o1' }]);
    const editor = principal([{ role: 'editor', orgId: 'o1' }]);
    expect(canGrant(admin, 'admin', { orgId: 'o1' })).toBe(true);
    expect(canGrant(admin, 'editor', { orgId: 'o1' })).toBe(true);
    expect(canGrant(admin, 'owner', { orgId: 'o1' })).toBe(false); // escalation refused
    expect(canGrant(owner, 'owner', { orgId: 'o1' })).toBe(true);
    expect(canGrant(editor, 'billing', { orgId: 'o1' })).toBe(true);
    expect(canGrant(editor, 'admin', { orgId: 'o1' })).toBe(false);
  });

  it('refuses escalation through a custom role holding a permission the granter lacks', () => {
    const admin = principal([{ role: 'admin', orgId: 'o1' }]);
    expect(canGrant(admin, 'key-operator', { orgId: 'o1' }, resolver)).toBe(true);
    // guardrail:reveal is owner-only: an admin cannot hand it out via a custom role.
    expect(canGrant(admin, 'super', { orgId: 'o1' }, resolver)).toBe(false);
    const owner = principal([{ role: 'owner', orgId: 'o1' }]);
    expect(canGrant(owner, 'super', { orgId: 'o1' }, resolver)).toBe(true);
  });

  it('is scope-sensitive and refuses unknown roles', () => {
    const admin = principal([{ role: 'admin', orgId: 'o1' }]);
    expect(canGrant(admin, 'key-operator', { orgId: 'o2' }, resolver)).toBe(false);
    expect(canGrant(admin, 'ghost', { orgId: 'o1' }, resolver)).toBe(false);
    expect(canGrant(admin, 'key-operator', { orgId: 'o1' })).toBe(false); // no resolver
    // An existing-but-empty role is trivially a subset.
    expect(canGrant(admin, 'empty', { orgId: 'o1' }, resolver)).toBe(true);
  });

  it('a custom-role holder may grant only what they themselves hold', () => {
    const op = principal([{ role: 'key-operator', orgId: 'o1' }]);
    expect(canGrant(op, 'key-operator', { orgId: 'o1' }, resolver)).toBe(true);
    expect(canGrant(op, 'viewer', { orgId: 'o1' }, resolver)).toBe(false); // viewer reads more
  });
});

describe('coveredOrgIds / coversWorkspace', () => {
  it('coveredOrgIds returns the set, or * for a bootstrap principal', () => {
    expect(coveredOrgIds(principal([{ role: 'viewer', orgId: 'o1' }]))).toEqual(['o1']);
    expect(coveredOrgIds(principal([{ role: 'owner', orgId: '*' }]))).toBe('*');
  });

  it('coversWorkspace is workspace-precise for a workspace-scoped member', () => {
    const p = principal([{ role: 'viewer', orgId: 'o1', workspaceId: 'w1' }]);
    expect(coversWorkspace(p, 'o1', 'w1')).toBe(true);
    expect(coversWorkspace(p, 'o1', 'w2')).toBe(false); // sibling workspace hidden
    const orgWide = principal([{ role: 'viewer', orgId: 'o1' }]);
    expect(coversWorkspace(orgWide, 'o1', 'w2')).toBe(true); // org-wide sees all
  });
});

describe('AccessControl ports', () => {
  it('InMemoryAccessControl mirrors can() over built-ins', async () => {
    const ac = new InMemoryAccessControl();
    const editor = principal([{ role: 'editor', orgId: 'o1' }]);
    expect(await ac.can(editor, 'route:create', { orgId: 'o1' })).toBe(true);
    expect(await ac.can(editor, 'org:create', { orgId: 'o1' })).toBe(false);
  });

  it('RoleAwareAccessControl refreshes, resolves custom roles, and fails closed', async () => {
    let refreshed = 0;
    const base = new StaticRoleResolver([
      { id: 'key-operator', name: 'k', permissions: ['key:disable'], builtin: false },
    ]);
    const ac = new RoleAwareAccessControl({
      get: (id) => base.get(id),
      ensureFresh: async () => {
        refreshed += 1;
      },
    });
    const op = principal([{ role: 'key-operator', orgId: 'o1' }]);
    expect(await ac.can(op, 'key:disable', { orgId: 'o1' })).toBe(true);
    expect(await ac.can(op, 'key:create', { orgId: 'o1' })).toBe(false);
    expect(refreshed).toBe(2);
    const broken = new RoleAwareAccessControl({
      get: () => {
        throw new Error('db down');
      },
    });
    expect(await broken.can(op, 'key:disable', { orgId: 'o1' })).toBe(false);
    // Built-ins still resolve when the resolver is broken.
    expect(
      await broken.can(principal([{ role: 'owner', orgId: 'o1' }]), 'org:read', { orgId: 'o1' }),
    ).toBe(true);
  });
});
