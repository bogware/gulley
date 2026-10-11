import type { Principal } from '@gulley/auth';
import { describe, expect, it } from 'vitest';
import {
  budgetExceededResponse,
  DEFAULT_BUDGET_SCOPE_KINDS,
  describeBudgetScope,
  endUserIdFor,
  hierarchyBudgetScopes,
  MAX_TEAM_BUDGET_SCOPES,
  parseBudgetScopeKinds,
} from './budget-scopes';

const principal = (over: Partial<Principal> = {}, groups?: string[]): Principal => ({
  kind: 'virtual-key',
  id: 'vk_1',
  displayName: 'k',
  authMode: 'virtual-key',
  scope: { orgId: 'org_1', workspaceId: 'ws_1', allowedProviders: '*', allowedModels: '*', groups },
  ...over,
});

describe('hierarchyBudgetScopes', () => {
  it('lists workspace → org → key → user → team(s) → project in enforcement order', () => {
    const scopes = hierarchyBudgetScopes({
      principal: principal({}, ['ml', 'platform', 'ml']),
      endUserId: 'alice',
      attribution: { project: 'checkout', session: 's1' },
      kinds: DEFAULT_BUDGET_SCOPE_KINDS,
    });
    expect(scopes).toEqual([
      'ws_1',
      'org:org_1',
      'key:ws_1:vk_1',
      'user:ws_1:alice',
      'team:ws_1:ml',
      'team:ws_1:platform',
      'project:ws_1:checkout',
    ]);
  });

  it('honours BUDGET_SCOPES and skips scopes the request cannot name', () => {
    expect(
      hierarchyBudgetScopes({ principal: principal(), kinds: new Set(['org', 'user', 'project']) }),
    ).toEqual(['ws_1', 'org:org_1']); // no user, no project attribution → only org beyond the ws
    expect(hierarchyBudgetScopes({ principal: principal(), kinds: new Set() })).toEqual(['ws_1']);
  });

  it('bounds the team scopes a principal with many groups reserves', () => {
    const groups = Array.from({ length: 40 }, (_, i) => `g${i}`);
    const scopes = hierarchyBudgetScopes({
      principal: principal({}, groups),
      kinds: new Set(['team']),
    });
    expect(scopes.filter((s) => s.startsWith('team:'))).toHaveLength(MAX_TEAM_BUDGET_SCOPES);
  });
});

describe('parseBudgetScopeKinds', () => {
  it('defaults to the whole hierarchy and reports unknown tokens', () => {
    expect(parseBudgetScopeKinds(undefined).kinds).toEqual(DEFAULT_BUDGET_SCOPE_KINDS);
    const r = parseBudgetScopeKinds(' Org, key ,workspace,galaxy,model');
    expect([...r.kinds]).toEqual(['org', 'key']);
    expect(r.unknown).toEqual(['galaxy', 'model']);
    expect(parseBudgetScopeKinds('').kinds.size).toBe(0);
  });
});

describe('endUserIdFor', () => {
  it('honours x-user-id only for an on-behalf-of service principal', () => {
    expect(endUserIdFor(principal(), { 'x-user-id': 'mallory' })).toBeUndefined();
    expect(endUserIdFor(principal({ userId: 'alice' }), { 'x-user-id': 'mallory' })).toBe('alice');
    const svc = principal({ kind: 'oauth-broker', serviceAccount: 'ci', onBehalfOf: true });
    expect(endUserIdFor(svc, { 'x-user-id': 'bob' })).toBe('bob');
    expect(endUserIdFor(svc, { 'x-user-id': ['carol', 'dave'] })).toBe('carol');
    expect(endUserIdFor(svc, {})).toBeUndefined();
    // Unsafe or oversized values are dropped, not truncated.
    expect(endUserIdFor(svc, { 'x-user-id': 'a b' })).toBeUndefined();
    expect(endUserIdFor(svc, { 'x-user-id': '{x}' })).toBeUndefined();
    expect(endUserIdFor(svc, { 'x-user-id': 'x'.repeat(129) })).toBeUndefined();
  });
});

describe('budgetExceededResponse', () => {
  it('names the entity and the calendar window, with retry-after until the reset', () => {
    const now = Date.UTC(2026, 9, 11, 22, 0, 0);
    const r = budgetExceededResponse(
      'key:ws_1:vk_1',
      {
        allowed: false,
        capMicroUsd: 5_000_000,
        usedMicroUsd: 4_990_000,
        window: { period: { kind: 'daily' }, resetsAtMs: Date.UTC(2026, 9, 12) },
      },
      120_000,
      now,
    );
    expect(r.status).toBe(402);
    expect(r.headers).toEqual({ 'x-should-retry': 'false', 'retry-after': String(2 * 3600) });
    expect(r.body.error.type).toBe('quota_for_entity_exceeded');
    expect(r.body.error.scope).toEqual({ kind: 'key', id: 'vk_1', workspace_id: 'ws_1' });
    expect(r.body.error.window).toEqual({ period: 'daily', resets_at: '2026-10-12T00:00:00.000Z' });
    expect(r.body.error.message).toBe(
      'Key vk_1 budget exceeded. Current spend: $4.99, limit: $5.00 (daily); this request needs up to $0.12. Resets at 2026-10-12T00:00:00.000Z.',
    );
  });

  it('describes a lifetime workspace cap without a retry-after', () => {
    const r = budgetExceededResponse(
      'ws_1',
      { allowed: false, capMicroUsd: 100, usedMicroUsd: 0 },
      2_500,
    );
    expect(r.headers).toEqual({ 'x-should-retry': 'false' });
    expect(r.body.error.scope).toEqual({ kind: 'workspace', id: 'ws_1', workspace_id: 'ws_1' });
    expect(r.body.error.window).toEqual({ period: 'lifetime' });
    expect(r.body.error.message).toBe(
      'Workspace budget exceeded. Current spend: $0.00, limit: $0.0001 (lifetime); this request needs up to $0.0025.',
    );
    expect(describeBudgetScope('org:o1').label).toBe('Organization');
    expect(describeBudgetScope('attr:session:abc').label).toBe('Attribution session:abc');
    expect(describeBudgetScope('model:claude-x')).toEqual({
      kind: 'model',
      id: 'claude-x',
      label: 'Model claude-x',
    });
  });
});
