import { describe, expect, it } from 'vitest';
import { CelTransformer } from './transform';

const act = {
  request: { model: 'gpt-4o', provider: 'openai', body: { temperature: 0.9 } },
  principal: { workspaceId: 'ws_1', orgId: 'org_1' },
};

describe('CelTransformer', () => {
  it('sets and removes request headers from CEL expressions', () => {
    const t = new CelTransformer({
      requestHeaders: [
        { name: 'X-Gulley-Workspace', value: 'principal.workspaceId' },
        { name: 'X-Model', value: '"model=" + request.model' },
        { name: 'X-Debug', remove: true },
      ],
    });
    const c = t.requestHeaderChanges(act);
    expect(c.set['x-gulley-workspace']).toBe('ws_1');
    expect(c.set['x-model']).toBe('model=gpt-4o');
    expect(c.remove).toContain('x-debug');
  });

  it('produces a request-body patch and reports needsBody', () => {
    const t = new CelTransformer({
      requestBody: [
        { field: 'max_tokens', value: '512' },
        { field: 'metadata', value: '{"team": principal.workspaceId}' },
      ],
    });
    expect(t.needsBody).toBe(false); // these exprs don't read request.body
    const patch = t.requestBodyPatch(act);
    expect(patch['max_tokens']).toBe(512);
    expect(patch['metadata']).toEqual({ team: 'ws_1' });
  });

  it('flags needsBody when an expression reads request.body', () => {
    const t = new CelTransformer({
      responseHeaders: [{ name: 'X-Temp', value: 'string(request.body.temperature)' }],
    });
    expect(t.needsBody).toBe(true);
    expect(t.responseHeaderChanges(act).set['x-temp']).toBe('0.9');
  });

  it('leaves a mutation unapplied when its expression errors (fail-open)', () => {
    const t = new CelTransformer({
      requestHeaders: [{ name: 'X-Bad', value: 'request.missing.field' }],
    });
    expect(t.requestHeaderChanges(act).set['x-bad']).toBeUndefined();
    expect(t.active).toBe(true);
  });
});
