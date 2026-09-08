import type { OidcProvider } from '@gulley/oidc';
import { describe, expect, it } from 'vitest';
import { type JwtAuthConfig, parseGroupScopeMap, resolveJwtPrincipal } from './jwt-auth';

/** A minimal OidcProvider whose verify() returns fixed claims — resolveJwtPrincipal
 *  only calls verify(), so the rest of the surface is unneeded. */
function providerReturning(claims: Record<string, unknown>): OidcProvider {
  return { verify: async () => ({ ok: true, claims }) } as unknown as OidcProvider;
}

describe('resolveJwtPrincipal groups', () => {
  const base = {
    audience: 'gulley',
    workspaceClaim: 'ws',
    orgClaim: 'org',
    groupsClaim: 'groups',
  } satisfies Omit<JwtAuthConfig, 'provider'>;

  it('maps an array groups claim onto the scope', async () => {
    const cfg: JwtAuthConfig = {
      ...base,
      provider: providerReturning({ ws: 'ws_1', org: 'org_1', sub: 'u1', groups: ['eng', 'beta'] }),
    };
    const p = await resolveJwtPrincipal('eyJ.a.b', cfg);
    expect(p).not.toBeNull();
    expect(p?.scope.groups).toEqual(['eng', 'beta']);
    expect(p?.id).toBe('u1');
  });

  it('parses a space/comma-delimited groups claim string', async () => {
    const cfg: JwtAuthConfig = {
      ...base,
      provider: providerReturning({ ws: 'ws_1', org: 'org_1', sub: 'u1', groups: 'eng, beta ops' }),
    };
    const p = await resolveJwtPrincipal('eyJ.a.b', cfg);
    expect(p?.scope.groups).toEqual(['eng', 'beta', 'ops']);
  });

  it('leaves groups undefined when no groupsClaim is configured', async () => {
    const cfg: JwtAuthConfig = {
      audience: 'gulley',
      workspaceClaim: 'ws',
      orgClaim: 'org',
      provider: providerReturning({ ws: 'ws_1', org: 'org_1', sub: 'u1', groups: ['eng'] }),
    };
    const p = await resolveJwtPrincipal('eyJ.a.b', cfg);
    expect(p?.scope.groups).toBeUndefined();
  });
});

describe('resolveJwtPrincipal Entra group/App-Role → scope allowlist', () => {
  const rules = parseGroupScopeMap(
    JSON.stringify([
      {
        group: 'gulley-eng',
        orgId: 'org_1',
        workspaceId: 'ws_eng',
        models: ['claude-x'],
        providers: ['anthropic'],
      },
      { group: 'gulley-admin', orgId: 'org_1', workspaceId: 'ws_admin' },
    ]),
  );
  const base = {
    audience: 'gulley',
    workspaceClaim: 'ws',
    orgClaim: 'org',
    groupsClaim: 'groups',
    groupScopeRules: rules,
  } satisfies Omit<JwtAuthConfig, 'provider'>;

  it('derives org/workspace + narrows models/providers from an Entra App Role (roles claim)', async () => {
    const p = await resolveJwtPrincipal('eyJ.a.b', {
      ...base,
      provider: providerReturning({ sub: 'u1', roles: ['gulley-eng'] }),
    });
    expect(p?.scope.workspaceId).toBe('ws_eng');
    expect(p?.scope.orgId).toBe('org_1');
    expect(p?.scope.allowedModels).toEqual(['claude-x']);
    expect(p?.scope.allowedProviders).toEqual(['anthropic']);
  });

  it('matches a raw security group value too', async () => {
    const p = await resolveJwtPrincipal('eyJ.a.b', {
      ...base,
      provider: providerReturning({ sub: 'u2', groups: ['gulley-admin'] }),
    });
    expect(p?.scope.workspaceId).toBe('ws_admin');
    expect(p?.scope.allowedModels).toBe('*'); // no restriction on that rule
  });

  it('DENIES a valid token whose groups match no rule (allowlist, no explicit ws claim)', async () => {
    const p = await resolveJwtPrincipal('eyJ.a.b', {
      ...base,
      provider: providerReturning({ sub: 'u3', roles: ['some-other-app-role'] }),
    });
    expect(p).toBeNull();
  });

  it('still honors an explicit workspace claim even with an allowlist configured', async () => {
    const p = await resolveJwtPrincipal('eyJ.a.b', {
      ...base,
      provider: providerReturning({ sub: 'u4', ws: 'ws_direct', org: 'org_1' }),
    });
    expect(p?.scope.workspaceId).toBe('ws_direct');
  });
});
