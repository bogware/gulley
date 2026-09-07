import { describe, expect, it } from 'vitest';
import {
  extractToolCalls,
  extractToolCallsFromSse,
  governToolCalls,
  parseToolPolicy,
  type ToolActivationContext,
} from './tool-governance';

const sse = (events: Array<{ event?: string; data: unknown }>): string =>
  events
    .map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${JSON.stringify(e.data)}\n\n`)
    .join('');

const CTX: ToolActivationContext = {
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  principal: { id: 'k1', orgId: 'org_1', workspaceId: 'ws_1' },
};

describe('extractToolCalls', () => {
  it('extracts Anthropic tool_use blocks with their input object', () => {
    const body = {
      content: [
        { type: 'text', text: 'let me run that' },
        { type: 'tool_use', id: 'tu_1', name: 'shell', input: { command: 'rm -rf /' } },
      ],
    };
    expect(extractToolCalls(body)).toEqual([
      { name: 'shell', input: { command: 'rm -rf /' }, id: 'tu_1' },
    ]);
  });

  it('extracts OpenAI chat tool_calls, parsing the JSON arguments string', () => {
    const body = {
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'write_file', arguments: '{"path":"/etc/passwd"}' },
              },
            ],
          },
        },
      ],
    };
    expect(extractToolCalls(body)).toEqual([
      { name: 'write_file', input: { path: '/etc/passwd' }, id: 'c1' },
    ]);
  });

  it('extracts OpenAI Responses function_call items', () => {
    const body = {
      output: [
        { type: 'function_call', name: 'delete', arguments: '{"id":42}', call_id: 'fc_1' },
        { type: 'message', content: [] },
      ],
    };
    expect(extractToolCalls(body)).toEqual([{ name: 'delete', input: { id: 42 }, id: 'fc_1' }]);
  });

  it('returns [] for a plain text response and for malformed arguments (kept raw)', () => {
    expect(extractToolCalls({ content: [{ type: 'text', text: 'hi' }] })).toEqual([]);
    const raw = extractToolCalls({
      choices: [{ message: { tool_calls: [{ function: { name: 'x', arguments: 'not json' } }] } }],
    });
    expect(raw).toEqual([{ name: 'x', input: 'not json', id: undefined }]);
  });
});

describe('extractToolCallsFromSse', () => {
  it('reassembles an Anthropic streamed tool_use from input_json_delta chunks', () => {
    const stream = sse([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'm' } } },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu_1', name: 'shell', input: {} },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"command":"rm ' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '-rf /"}' },
        },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    expect(extractToolCallsFromSse(stream, 'anthropic')).toEqual([
      { name: 'shell', input: { command: 'rm -rf /' }, id: 'tu_1' },
    ]);
  });

  it('reassembles an OpenAI chat streamed tool call from argument deltas', () => {
    const stream =
      sse([
        {
          data: {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'c1',
                      type: 'function',
                      function: { name: 'write_file', arguments: '' },
                    },
                  ],
                },
              },
            ],
          },
        },
        {
          data: {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"/etc/' } }] } },
            ],
          },
        },
        {
          data: {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: 'passwd"}' } }] } },
            ],
          },
        },
      ]) + 'data: [DONE]\n\n';
    expect(extractToolCallsFromSse(stream, 'openai')).toEqual([
      { name: 'write_file', input: { path: '/etc/passwd' }, id: 'c1' },
    ]);
  });

  it('reassembles an OpenAI Responses streamed function_call', () => {
    const stream = sse([
      {
        event: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'delete',
            arguments: '',
          },
        },
      },
      {
        event: 'response.function_call_arguments.delta',
        data: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"id":' },
      },
      {
        event: 'response.function_call_arguments.delta',
        data: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '42}' },
      },
    ]);
    expect(extractToolCallsFromSse(stream, 'responses')).toEqual([
      { name: 'delete', input: { id: 42 }, id: 'call_1' },
    ]);
  });

  it('returns [] for a plain text stream (no tool call)', () => {
    const stream = sse([
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      },
    ]);
    expect(extractToolCallsFromSse(stream, 'anthropic')).toEqual([]);
  });
});

describe('parseToolPolicy + governToolCalls', () => {
  it('denies a tool call matching a deny rule', () => {
    const policy = parseToolPolicy(
      JSON.stringify([
        {
          name: 'no-destructive-shell',
          effect: 'deny',
          expr: 'tool.name == "shell" && tool.input.command.contains("rm -rf")',
        },
      ]),
    )!;
    const calls = extractToolCalls({
      content: [{ type: 'tool_use', id: 't1', name: 'shell', input: { command: 'rm -rf /' } }],
    });
    const res = governToolCalls(policy, calls, CTX);
    expect(res.denied?.call.name).toBe('shell');
    expect(res.denied?.reason).toContain('no-destructive-shell');
  });

  it('allows a benign tool call under the same policy', () => {
    const policy = parseToolPolicy(
      JSON.stringify([
        {
          name: 'no-destructive-shell',
          effect: 'deny',
          expr: 'tool.name == "shell" && tool.input.command.contains("rm -rf")',
        },
      ]),
    )!;
    const calls = extractToolCalls({
      content: [{ type: 'tool_use', id: 't1', name: 'shell', input: { command: 'ls -la' } }],
    });
    expect(governToolCalls(policy, calls, CTX).denied).toBeUndefined();
  });

  it('supports an allow-list: only permitted tools pass', () => {
    const policy = parseToolPolicy(
      JSON.stringify([
        { name: 'allowed-tools', effect: 'allow', expr: 'tool.name in ["read_file", "list_dir"]' },
      ]),
    )!;
    const denied = governToolCalls(policy, [{ name: 'exec', input: {} }], CTX);
    expect(denied.denied?.call.name).toBe('exec'); // not in the allow-list
    const allowed = governToolCalls(policy, [{ name: 'read_file', input: {} }], CTX);
    expect(allowed.denied).toBeUndefined();
  });

  it('a response with no tool calls is trivially allowed', () => {
    const policy = parseToolPolicy(JSON.stringify([{ effect: 'deny', expr: 'true' }]))!;
    expect(governToolCalls(policy, [], CTX).denied).toBeUndefined();
  });

  it('returns undefined for an unset policy and throws on a malformed one', () => {
    expect(parseToolPolicy(undefined)).toBeUndefined();
    expect(parseToolPolicy('   ')).toBeUndefined();
    expect(() => parseToolPolicy('{not json')).toThrow(/not valid JSON/);
    expect(() => parseToolPolicy('{"expr":"x"}')).toThrow(/must be a JSON array/);
    expect(() => parseToolPolicy(JSON.stringify([{ expr: 'x' }]))).toThrow(/effect/);
  });

  it('can scope a deny by principal workspace', () => {
    const policy = parseToolPolicy(
      JSON.stringify([
        { effect: 'deny', expr: 'principal.workspaceId == "ws_locked" && tool.name == "shell"' },
      ]),
    )!;
    const calls: Parameters<typeof governToolCalls>[1] = [{ name: 'shell', input: {} }];
    expect(governToolCalls(policy, calls, CTX).denied).toBeUndefined(); // ws_1 not locked
    expect(
      governToolCalls(policy, calls, {
        ...CTX,
        principal: { ...CTX.principal, workspaceId: 'ws_locked' },
      }).denied?.call.name,
    ).toBe('shell');
  });
});
