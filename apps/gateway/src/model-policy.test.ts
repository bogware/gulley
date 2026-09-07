import type { ConfigDocument } from '@gulley/config';
import { describe, expect, it } from 'vitest';
import {
  buildModelPolicy,
  modelAllowedByPolicy,
  modelPatternMatches,
  modelPolicyFromEnv,
  unionModelPolicy,
} from './model-policy';

describe('modelPatternMatches', () => {
  it('matches exact, wildcard-all, and glob patterns', () => {
    expect(modelPatternMatches('claude-opus-4-8', 'claude-opus-4-8')).toBe(true);
    expect(modelPatternMatches('*', 'anything')).toBe(true);
    expect(modelPatternMatches('claude-*', 'claude-sonnet-4-6')).toBe(true);
    expect(modelPatternMatches('gpt-4o-*', 'gpt-4o-mini')).toBe(true);
    expect(modelPatternMatches('claude-*', 'gpt-4o')).toBe(false);
    expect(modelPatternMatches('gpt-4o', 'gpt-4o-mini')).toBe(false); // exact, no glob
  });
});

describe('modelAllowedByPolicy', () => {
  it('deny wins over allow', () => {
    const policy = { allow: ['claude-*'], deny: ['claude-opus-*'] };
    expect(modelAllowedByPolicy(policy, 'claude-sonnet-4-6')).toBe(true);
    expect(modelAllowedByPolicy(policy, 'claude-opus-4-8')).toBe(false); // denied despite allow
  });

  it('an allow-list restricts to matching models', () => {
    const policy = { allow: ['claude-*'], deny: [] };
    expect(modelAllowedByPolicy(policy, 'claude-sonnet-4-6')).toBe(true);
    expect(modelAllowedByPolicy(policy, 'gpt-4o')).toBe(false); // not in the allow-list
  });

  it('deny-only rejects the denied and permits everything else', () => {
    const policy = { allow: [], deny: ['gpt-*'] };
    expect(modelAllowedByPolicy(policy, 'gpt-4o')).toBe(false);
    expect(modelAllowedByPolicy(policy, 'claude-opus-4-8')).toBe(true);
  });

  it('an empty policy permits everything', () => {
    expect(modelAllowedByPolicy({ allow: [], deny: [] }, 'anything')).toBe(true);
  });
});

describe('buildModelPolicy', () => {
  const doc = (
    policies: Array<{ name: string; config: Record<string, unknown> }>,
  ): ConfigDocument => ({
    apiVersion: 'gulley/v1',
    orgs: [{ name: 'Acme', workspaces: [{ name: 'prod', policies } as never] }],
  });

  it('returns undefined when no policy entity carries a model allow/deny', () => {
    expect(buildModelPolicy(doc([]))).toBeUndefined();
    expect(buildModelPolicy(doc([{ name: 'p', config: { note: 'unrelated' } }]))).toBeUndefined();
  });

  it('unions allow and deny across policy entities', () => {
    const policy = buildModelPolicy(
      doc([
        { name: 'coders', config: { allow: ['claude-*'] } },
        { name: 'analysts', config: { allow: ['gpt-4o-*'], deny: ['claude-opus-*'] } },
      ]),
    )!;
    expect(policy.allow.sort()).toEqual(['claude-*', 'gpt-4o-*']);
    expect(policy.deny).toEqual(['claude-opus-*']);
    // A model must be in the union of allows and not denied.
    expect(modelAllowedByPolicy(policy, 'claude-sonnet-4-6')).toBe(true);
    expect(modelAllowedByPolicy(policy, 'claude-opus-4-8')).toBe(false);
    expect(modelAllowedByPolicy(policy, 'gemini-pro')).toBe(false); // not in any allow
  });
});

describe('unionModelPolicy', () => {
  it('unions allow and deny, and preserves an env floor when the document is empty', () => {
    const envFloor = { allow: [], deny: ['claude-opus-*'] };
    // A config document with no model policy (undefined) must NOT drop the env floor.
    expect(unionModelPolicy(envFloor, undefined)).toEqual({ allow: [], deny: ['claude-opus-*'] });
    // Document adds an allow-list; env deny survives.
    expect(unionModelPolicy(envFloor, { allow: ['claude-*'], deny: [] })).toEqual({
      allow: ['claude-*'],
      deny: ['claude-opus-*'],
    });
    expect(unionModelPolicy(undefined, undefined)).toBeUndefined();
  });
});

describe('modelPolicyFromEnv', () => {
  it('parses comma-separated allow/deny, undefined when both empty', () => {
    expect(modelPolicyFromEnv('', '')).toBeUndefined();
    expect(modelPolicyFromEnv('claude-*, gpt-4o-*', 'gpt-3.5-*')).toEqual({
      allow: ['claude-*', 'gpt-4o-*'],
      deny: ['gpt-3.5-*'],
    });
  });
});
