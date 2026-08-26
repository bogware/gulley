import { describe, expect, it } from 'vitest';
import { CelAuthorizer } from './policy';

const req = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  request: { model: 'gpt-4o', provider: 'openai', source_ip: '10.1.2.3', ...over },
  principal: { orgId: 'org_1', workspaceId: 'ws_1' },
});

describe('CelAuthorizer', () => {
  it('deny-first: a matching deny rule blocks', () => {
    const az = new CelAuthorizer([
      {
        effect: 'deny',
        name: 'no-experimental',
        expr: 'request.model.startsWith("experimental-")',
      },
    ]);
    expect(az.authorize(req({ model: 'gpt-4o' })).allowed).toBe(true);
    const d = az.authorize(req({ model: 'experimental-x' }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('deny:no-experimental');
  });

  it('allow-list: at least one allow rule must match', () => {
    const az = new CelAuthorizer([
      {
        effect: 'allow',
        name: 'internal-net',
        expr: 'cidr("10.0.0.0/8").containsIP(request.source_ip)',
      },
      { effect: 'allow', name: 'openai', expr: 'request.provider == "openai"' },
    ]);
    expect(az.authorize(req({ source_ip: '8.8.8.8', provider: 'openai' })).allowed).toBe(true);
    const denied = az.authorize(req({ source_ip: '8.8.8.8', provider: 'anthropic' }));
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('no allow rule matched');
  });

  it('no allow rules → default allow (only deny gates)', () => {
    const az = new CelAuthorizer([{ effect: 'deny', expr: 'request.provider == "banned"' }]);
    expect(az.authorize(req()).allowed).toBe(true);
  });

  it('an erroring rule is a non-match (allow-list fails closed)', () => {
    const az = new CelAuthorizer([
      { effect: 'allow', name: 'body', expr: 'request.body.temperature < 1.0' },
    ]);
    // request.body is absent → rule errors → no allow matched → denied.
    expect(az.authorize(req()).allowed).toBe(false);
    // present and satisfied → allowed.
    expect(az.authorize(req({ body: { temperature: 0.2 } })).allowed).toBe(true);
  });

  it('reports which attributes rules read', () => {
    const az = new CelAuthorizer([{ effect: 'deny', expr: 'request.body.stream == true' }]);
    expect(az.reads('request.body')).toBe(true);
    expect(az.reads('request.headers')).toBe(false);
  });
});
