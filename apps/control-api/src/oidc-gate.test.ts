import { describe, expect, it } from 'vitest';
import { extractGroups, hasGroupOverage, mapMemberships, parseRoleMap } from './oidc-gate';

describe('extractGroups (App Roles primary + group fallback, unioned)', () => {
  it('reads Entra App Roles (the `roles` claim)', () => {
    expect(extractGroups({ roles: ['gulley-admin', 'gulley-viewer'] }, 'groups')).toEqual([
      'gulley-admin',
      'gulley-viewer',
    ]);
  });

  it('unions App Roles, the configured claim, and raw groups (deduped)', () => {
    const got = extractGroups(
      { roles: ['gulley-admin'], groups: ['00000000-0000-0000-0000-000000000001'], wids: ['x'] },
      'wids',
    );
    expect(got).toEqual([
      'gulley-admin',
      'x',
      '00000000-0000-0000-0000-000000000001',
    ]);
  });

  it('accepts a scalar claim value and ignores non-strings', () => {
    expect(extractGroups({ roles: 'solo' }, 'groups')).toEqual(['solo']);
    expect(extractGroups({ roles: [1, 'ok', null] }, 'groups')).toEqual(['ok']);
  });

  it('is empty when no claim is present', () => {
    expect(extractGroups({ sub: 'u1' }, 'groups')).toEqual([]);
  });
});

describe('hasGroupOverage', () => {
  it('detects the Entra >200-group overage indirection', () => {
    expect(
      hasGroupOverage({ _claim_names: { groups: 'src1' }, _claim_sources: { src1: { endpoint: 'https://graph...' } } }),
    ).toBe(true);
  });
  it('is false for a normal token', () => {
    expect(hasGroupOverage({ groups: ['a', 'b'] })).toBe(false);
    expect(hasGroupOverage({ _claim_names: { emails: 'x' } })).toBe(false);
    expect(hasGroupOverage({})).toBe(false);
  });
});

describe('mapMemberships with App Roles', () => {
  it('maps an App Role name to a role via OIDC_ROLE_MAP, expanding orgId "*"', () => {
    const rules = parseRoleMap('[{"group":"gulley-admin","role":"owner","orgId":"*"}]');
    const got = mapMemberships(extractGroups({ roles: ['gulley-admin'] }, 'groups'), rules, [
      'org-1',
      'org-2',
    ]);
    expect(got).toEqual([
      { role: 'owner', orgId: 'org-1', workspaceId: null },
      { role: 'owner', orgId: 'org-2', workspaceId: null },
    ]);
  });

  it('grants nothing when no App Role or group matches a rule', () => {
    const rules = parseRoleMap('[{"group":"gulley-admin","role":"owner","orgId":"*"}]');
    expect(mapMemberships(['someone-else'], rules, ['org-1'])).toEqual([]);
  });
});
