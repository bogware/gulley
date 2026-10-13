import { describe, expect, it } from 'vitest';
import {
  configFromForm,
  EMPTY_ROUTE_GROUP_FORM,
  formFromEntity,
  groupOptionsLabel,
  isLegacyRouteConfig,
} from './route-edit';

const group = {
  clientPath: '/v1/messages',
  mode: 'loadbalance',
  providers: ['anthropic', 'bedrock'],
  select: 'cheapest',
  weights: { anthropic: 3 },
  onStatusCodes: [429, 503],
  hedgeDelayMs: 250,
  modelMap: { bedrock: { 'claude-sonnet-4-6': 'us.anthropic.claude-sonnet-4-6-v1:0' } },
};

describe('route-edit', () => {
  it('round-trips a full route group through the form', () => {
    const form = formFromEntity('messages-ha', group);
    expect(form).toMatchObject({
      name: 'messages-ha',
      clientPath: '/v1/messages',
      mode: 'loadbalance',
      providers: 'anthropic, bedrock',
      select: 'cheapest',
      onStatusCodes: '429, 503',
      hedgeDelayMs: '250',
    });
    const built = configFromForm(form);
    expect(built).toEqual({ ok: true, config: group });
  });

  it('flags the legacy console shape and prefills only what it can', () => {
    const legacy = { strategy: { mode: 'loadbalance', targets: [{ name: 'a', weight: 50 }] } };
    expect(isLegacyRouteConfig(legacy)).toBe(true);
    expect(isLegacyRouteConfig(group)).toBe(false);
    const form = formFromEntity('old', legacy);
    expect(form).toMatchObject({ name: 'old', mode: 'loadbalance', clientPath: '', providers: '' });
    // Not convertible until the operator fills in the path and providers.
    expect(configFromForm(form)).toMatchObject({ ok: false, error: expect.stringMatching(/path/) });
  });

  it('refuses what the schema would refuse, in the operator’s words', () => {
    const base = { ...EMPTY_ROUTE_GROUP_FORM, clientPath: '/v1/messages', providers: 'a, b' };
    expect(configFromForm({ ...base, providers: 'anthropic' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/two providers/),
    });
    expect(configFromForm({ ...base, weights: '{"a": 0}' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/positive/),
    });
    expect(configFromForm({ ...base, weights: '[1]' })).toMatchObject({ ok: false });
    expect(configFromForm({ ...base, onStatusCodes: '429, x' })).toMatchObject({ ok: false });
    expect(configFromForm({ ...base, hedgeDelayMs: '-1' })).toMatchObject({ ok: false });
    expect(configFromForm({ ...base, modelMap: '{"bedrock": "nope"}' })).toMatchObject({
      ok: false,
    });
    // Blank optionals are simply omitted (never emitted as empty values).
    expect(configFromForm(base)).toEqual({
      ok: true,
      config: { clientPath: '/v1/messages', mode: 'fallback', providers: ['a', 'b'] },
    });
  });

  it('summarises the optional knobs for the list', () => {
    expect(groupOptionsLabel(group)).toBe(
      'select cheapest · weights anthropic:3 · on 429,503 · hedge 250ms · modelMap bedrock',
    );
    expect(groupOptionsLabel({ clientPath: '/v1/messages' })).toBe('defaults');
  });
});
