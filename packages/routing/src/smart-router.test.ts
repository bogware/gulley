import { describe, expect, it } from 'vitest';
import {
  MapSmartRouteResolver,
  type SmartRoutingIdentity,
  type SmartRoutingPolicy,
  type SmartSelector,
  selectorSpecificity,
} from './smart-router';

const ID: SmartRoutingIdentity = {
  userId: 'u1',
  groups: ['eng', 'beta'],
  orgId: 'org1',
  workspaceId: 'ws1',
  clientPaths: ['/v1/messages', '/v1/chat/completions'],
};

/** A minimal policy with just a selector + name (the routing details are inert
 *  for resolution). */
function policy(name: string, selector: SmartSelector, priority?: number): SmartRoutingPolicy {
  return {
    name,
    objective: 'cost-tier',
    classifier: { mode: 'rules-then-llm' },
    categoryRoutes: { cheap: 'small', hard: 'frontier' },
    selector,
    ...(priority !== undefined ? { priority } : {}),
  };
}

describe('selectorSpecificity', () => {
  it('orders axes user > group > route > workspace > org, each dominating all below', () => {
    expect(selectorSpecificity({ user: 'x' })).toBeGreaterThan(
      selectorSpecificity({ group: 'x', route: 'x', workspace: 'x', org: 'x' }),
    );
    expect(selectorSpecificity({ group: 'x' })).toBeGreaterThan(
      selectorSpecificity({ route: 'x', workspace: 'x', org: 'x' }),
    );
    expect(selectorSpecificity({ route: 'x' })).toBeGreaterThan(
      selectorSpecificity({ workspace: 'x', org: 'x' }),
    );
    expect(selectorSpecificity({ workspace: 'x' })).toBeGreaterThan(
      selectorSpecificity({ org: 'x' }),
    );
    expect(selectorSpecificity({})).toBe(0);
  });

  it('is more specific when more axes are pinned', () => {
    expect(selectorSpecificity({ user: 'x', group: 'y' })).toBeGreaterThan(
      selectorSpecificity({ user: 'x' }),
    );
  });
});

describe('MapSmartRouteResolver.resolve', () => {
  it('picks the most-specific matching policy (user beats group beats org)', () => {
    const r = new MapSmartRouteResolver([
      policy('org-wide', { org: 'org1' }),
      policy('group-eng', { group: 'eng' }),
      policy('user-u1', { user: 'u1' }),
    ]);
    expect(r.resolve(ID)?.name).toBe('user-u1');
  });

  it('falls to the next axis when the most-specific does not match', () => {
    const r = new MapSmartRouteResolver([
      policy('org-wide', { org: 'org1' }),
      policy('group-eng', { group: 'eng' }),
      policy('user-other', { user: 'someone-else' }),
    ]);
    expect(r.resolve(ID)?.name).toBe('group-eng');
  });

  it('matches group membership and route membership by list containment', () => {
    expect(new MapSmartRouteResolver([policy('g', { group: 'beta' })]).resolve(ID)?.name).toBe('g');
    expect(new MapSmartRouteResolver([policy('g', { group: 'nope' })]).resolve(ID)).toBeUndefined();
    expect(
      new MapSmartRouteResolver([policy('r', { route: '/v1/chat/completions' })]).resolve(ID)?.name,
    ).toBe('r');
    expect(
      new MapSmartRouteResolver([policy('r', { route: '/v1/embeddings' })]).resolve(ID),
    ).toBeUndefined();
  });

  it('requires every set selector field to match (AND semantics)', () => {
    // user matches but group does not ⇒ no match.
    expect(
      new MapSmartRouteResolver([policy('and', { user: 'u1', group: 'nope' })]).resolve(ID),
    ).toBeUndefined();
    expect(
      new MapSmartRouteResolver([policy('and', { user: 'u1', group: 'eng' })]).resolve(ID)?.name,
    ).toBe('and');
  });

  it('breaks ties among equally-specific matches by priority (higher wins)', () => {
    const r = new MapSmartRouteResolver([
      policy('lo', { group: 'eng' }, 1),
      policy('hi', { group: 'beta' }, 5),
    ]);
    expect(r.resolve(ID)?.name).toBe('hi');
  });

  it('breaks priority ties by name for determinism', () => {
    const r = new MapSmartRouteResolver([
      policy('bbb', { group: 'beta' }),
      policy('aaa', { group: 'eng' }),
    ]);
    expect(r.resolve(ID)?.name).toBe('aaa');
  });

  it('treats an empty selector as a global default (lowest precedence)', () => {
    const r = new MapSmartRouteResolver([policy('global', {}), policy('user', { user: 'u1' })]);
    expect(r.resolve(ID)?.name).toBe('user');
    // With only the global policy, it still matches everyone.
    expect(new MapSmartRouteResolver([policy('global', {})]).resolve(ID)?.name).toBe('global');
  });

  it('returns undefined when nothing matches', () => {
    const r = new MapSmartRouteResolver([policy('x', { org: 'other-org' })]);
    expect(r.resolve(ID)).toBeUndefined();
  });
});
