import { afterEach, describe, expect, it } from 'vitest';
import { GatewayMetrics } from './gateway-metrics';
import { Registry } from './registry';
import { type MetricsServerHandle, startMetricsServer } from './server';

describe('Registry', () => {
  it('renders counters with sorted labels', () => {
    const reg = new Registry();
    const c = reg.counter('gulley_test_total', 'A test counter.');
    c.inc({ provider: 'anthropic', status: 'ok' });
    c.inc({ provider: 'anthropic', status: 'ok' });
    c.inc({ provider: 'openai', status: 'error' });
    const out = reg.render();
    expect(out).toContain('# TYPE gulley_test_total counter');
    expect(out).toContain('gulley_test_total{provider="anthropic",status="ok"} 2');
    expect(out).toContain('gulley_test_total{provider="openai",status="error"} 1');
  });

  it('renders histograms with cumulative le buckets, sum, and count', () => {
    const reg = new Registry();
    const h = reg.histogram('gulley_d_seconds', 'Durations.', [0.5, 1, 5]);
    h.observe({ provider: 'anthropic' }, 0.25);
    h.observe({ provider: 'anthropic' }, 2);
    const out = reg.render();
    expect(out).toContain('gulley_d_seconds_bucket{le="0.5",provider="anthropic"} 1');
    expect(out).toContain('gulley_d_seconds_bucket{le="1",provider="anthropic"} 1');
    expect(out).toContain('gulley_d_seconds_bucket{le="5",provider="anthropic"} 2');
    expect(out).toContain('gulley_d_seconds_bucket{le="+Inf",provider="anthropic"} 2');
    expect(out).toContain('gulley_d_seconds_sum{provider="anthropic"} 2.25');
    expect(out).toContain('gulley_d_seconds_count{provider="anthropic"} 2');
  });
});

describe('GatewayMetrics', () => {
  it('derives request/token/cost/cache/guardrail/duration series from one event', () => {
    let t = 1000;
    const m = new GatewayMetrics(() => t);
    t = 2500; // 1.5s after start
    m.record({
      provider: 'anthropic',
      requestModel: 'claude-sonnet-4-6',
      responseModel: 'claude-sonnet-4-6',
      status: 'ok',
      statusCode: 200,
      streamed: true,
      inputTokens: 130,
      outputTokens: 42,
      costMicroUsd: 500,
      startedAtMs: 1000,
      cacheStatus: 'miss',
      guardrailAction: 'mask',
    });
    const out = m.render();
    expect(out).toContain(
      'gulley_requests_total{model="claude-sonnet-4-6",provider="anthropic",status="ok",status_code="200",streamed="true"} 1',
    );
    expect(out).toContain('type="input"');
    expect(out).toContain(
      'gulley_tokens_total{model="claude-sonnet-4-6",provider="anthropic",type="output"} 42',
    );
    expect(out).toContain(
      'gulley_cost_micro_usd_total{model="claude-sonnet-4-6",provider="anthropic"} 500',
    );
    expect(out).toContain('gulley_cache_events_total{status="miss"} 1');
    expect(out).toContain('gulley_guardrail_actions_total{action="mask"} 1');
    expect(out).toContain(
      'gulley_request_duration_seconds_count{provider="anthropic",status="ok"} 1',
    );
    expect(out).toContain(
      'gulley_request_duration_seconds_sum{provider="anthropic",status="ok"} 1.5',
    );
  });

  it('counts failovers', () => {
    const m = new GatewayMetrics();
    m.recordFailover('anthropic');
    m.recordFailover('anthropic');
    expect(m.render()).toContain('gulley_failovers_total{target="anthropic"} 2');
  });

  it('labels saved cost by source (prompt_cache default, response_cache on a hit)', () => {
    const m = new GatewayMetrics();
    const base = {
      provider: 'anthropic',
      requestModel: 'claude-sonnet-4-6',
      responseModel: 'claude-sonnet-4-6',
      status: 'ok',
      statusCode: 200,
      streamed: false,
      inputTokens: 0,
      outputTokens: 0,
      costMicroUsd: 0,
      startedAtMs: 0,
    };
    // A provider prompt-cache saving (no explicit source → defaults to prompt_cache).
    m.record({ ...base, cacheSavedMicroUsd: 300 });
    // A gateway response-cache hit.
    m.record({ ...base, cacheSavedMicroUsd: 700, cacheSavedSource: 'response_cache' });
    const out = m.render();
    expect(out).toContain('gulley_cost_saved_micro_usd_total{source="prompt_cache"} 300');
    expect(out).toContain('gulley_cost_saved_micro_usd_total{source="response_cache"} 700');
  });
});

describe('metrics server', () => {
  let handle: MetricsServerHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('serves /metrics and /health on a dedicated listener', async () => {
    const m = new GatewayMetrics();
    m.recordFailover('openai');
    handle = await startMetricsServer({ metrics: m, port: 0, host: '127.0.0.1' });

    const metrics = await fetch(`http://127.0.0.1:${handle.port}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get('content-type')).toContain('text/plain');
    expect(await metrics.text()).toContain('gulley_failovers_total{target="openai"} 1');

    const health = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(health.status).toBe(200);

    const other = await fetch(`http://127.0.0.1:${handle.port}/nope`);
    expect(other.status).toBe(404);
  });
});
