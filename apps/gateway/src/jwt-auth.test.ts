import type { OidcProvider } from '@gulley/oidc';
import { describe, expect, it } from 'vitest';
import { type JwtAuthConfig, resolveJwtPrincipal } from './jwt-auth';

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
