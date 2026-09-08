import { describe, expect, it } from 'vitest';
import { parsePromText, summarizeGatewayMetrics } from './gateway-metrics';

const SAMPLE = `# HELP gulley_requests_total Proxied requests
# TYPE gulley_requests_total counter
gulley_requests_total{provider="anthropic",model="claude-x",status="ok",status_code="200",streamed="true"} 80
gulley_requests_total{provider="anthropic",model="claude-x",status="error",status_code="500",streamed="false"} 20
gulley_requests_total{provider="openai",model="gpt-x",status="ok",status_code="200",streamed="false"} 100
# TYPE gulley_tokens_total counter
gulley_tokens_total{provider="anthropic",model="claude-x",type="input"} 1000
gulley_tokens_total{provider="anthropic",model="claude-x",type="output"} 500
# TYPE gulley_cost_micro_usd_total counter
gulley_cost_micro_usd_total{provider="anthropic",model="claude-x"} 123456
# TYPE gulley_cache_events_total counter
gulley_cache_events_total{status="hit-exact"} 30
gulley_cache_events_total{status="miss"} 70
# TYPE gulley_cost_saved_micro_usd_total counter
gulley_cost_saved_micro_usd_total{source="prompt_cache"} 4000
# TYPE gulley_guardrail_actions_total counter
gulley_guardrail_actions_total{action="block"} 3
# TYPE gulley_failovers_total counter
gulley_failovers_total{target="anthropic-primary"} 2
# TYPE gulley_request_duration_seconds histogram
gulley_request_duration_seconds_bucket{provider="anthropic",status="ok",le="0.5"} 50
gulley_request_duration_seconds_bucket{provider="anthropic",status="ok",le="1"} 90
gulley_request_duration_seconds_bucket{provider="anthropic",status="ok",le="+Inf"} 100
gulley_request_duration_seconds_sum{provider="anthropic",status="ok"} 55
gulley_request_duration_seconds_count{provider="anthropic",status="ok"} 100
`;

describe('parsePromText / summarizeGatewayMetrics', () => {
  it('folds counters + histogram into a summary', () => {
    const s = summarizeGatewayMetrics(parsePromText(SAMPLE), '2026-09-07T00:00:00Z');
    expect(s.requests.total).toBe(200);
    expect(s.requests.byStatus['ok']).toBe(180);
    expect(s.requests.byStatus['error']).toBe(20);
    expect(s.requests.byProvider['anthropic']).toBe(100);
    expect(s.requests.streamedShare).toBeCloseTo(80 / 200, 5);
    expect(s.tokens.input).toBe(1000);
    expect(s.tokens.output).toBe(500);
    expect(s.cost.totalMicroUsd).toBe(123456);
    expect(s.cost.savedMicroUsd['prompt_cache']).toBe(4000);
    expect(s.cache.hitRatio).toBeCloseTo(30 / 100, 5);
    expect(s.guardrail['block']).toBe(3);
    expect(s.failovers['anthropic-primary']).toBe(2);
    expect(s.duration.count).toBe(100);
    expect(s.duration.avgSeconds).toBeCloseTo(0.55, 5);
    // p50: 100 samples, target 50 lands exactly at the 0.5 bucket boundary.
    expect(s.duration.p50).toBeGreaterThan(0);
    expect(s.duration.p50).toBeLessThanOrEqual(0.5);
    expect(s.duration.p90).toBeGreaterThan(0.5);
    expect(s.duration.p90).toBeLessThanOrEqual(1);
  });

  it('is defensive: blank/malformed input yields an empty summary, never throws', () => {
    const s = summarizeGatewayMetrics(parsePromText('# just a comment\ngarbage line\n\n'), 'now');
    expect(s.requests.total).toBe(0);
    expect(s.cache.hitRatio).toBe(0);
    expect(s.duration.p99).toBe(0);
  });

  it('handles an unknown future metric name without breaking', () => {
    const p = parsePromText(
      'gulley_new_metric_total{x="y"} 5\ngulley_requests_total{status="ok"} 1\n',
    );
    expect(p.counters.get('gulley_new_metric_total')?.[0]?.value).toBe(5);
    expect(summarizeGatewayMetrics(p, 'now').requests.total).toBe(1);
  });
});
