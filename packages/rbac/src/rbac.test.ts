import { describe, expect, it } from 'vitest';
import { InMemoryAccessControl } from './access-control';
import { can, covers, coveredOrgIds, coversWorkspace, maxRankAt } from './engine';
import { PERMISSIONS_BY_ROLE } from './permissions';
import type { AdminPrincipal } from './principal';
import { roleRank } from './principal';

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

describe('can (fail-closed)', () => {
  const viewer = principal([{ role: 'viewer', orgId: 'o1' }]);
  const editor = principal([{ role: 'editor', orgId: 'o1' }]);
  const owner = principal([{ role: 'owner', orgId: 'o1' }]);

  it('viewer can read but not write', () => {
    expect(can(viewer, 'org:read', { orgId: 'o1' })).toBe(true);
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

  it('roles strictly nest (owner ⊇ admin ⊇ editor ⊇ viewer)', () => {
    for (const p of PERMISSIONS_BY_ROLE.viewer) expect(PERMISSIONS_BY_ROLE.owner.has(p)).toBe(true);
    for (const p of PERMISSIONS_BY_ROLE.editor) expect(PERMISSIONS_BY_ROLE.admin.has(p)).toBe(true);
  });
});

describe('maxRankAt / coveredOrgIds', () => {
  it('reports the highest covering role rank', () => {
    const p = principal([
      { role: 'viewer', orgId: 'o1' },
      { role: 'admin', orgId: 'o1', workspaceId: 'w1' },
    ]);
    expect(maxRankAt(p, { orgId: 'o1' })).toBe(roleRank.viewer);
    expect(maxRankAt(p, { orgId: 'o1', workspaceId: 'w1' })).toBe(roleRank.admin);
    expect(maxRankAt(p, { orgId: 'o2' })).toBe(-1);
  });

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

describe('InMemoryAccessControl', () => {
  it('mirrors can()', async () => {
    const ac = new InMemoryAccessControl();
    const editor = principal([{ role: 'editor', orgId: 'o1' }]);
    expect(await ac.can(editor, 'route:create', { orgId: 'o1' })).toBe(true);
    expect(await ac.can(editor, 'org:create', { orgId: 'o1' })).toBe(false);
  });
});
