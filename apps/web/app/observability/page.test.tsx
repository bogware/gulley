import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Query results the page consumes in hook order on EVERY render (status, then metrics) —
// the page re-renders after its own effects, so the mock must be stable across renders.
const results: Array<Record<string, unknown>> = [];
let call = 0;
vi.mock('../../lib/hooks', () => ({
  useAdminQuery: () =>
    results[call++ % Math.max(results.length, 1)] ?? {
      data: undefined,
      loading: true,
      error: undefined,
      refetch: vi.fn(),
    },
}));
vi.mock('../../lib/admin-context', () => ({
  useAdmin: () => ({ api: {}, authed: true, ready: true }),
}));

import ObservabilityPage from './page';

const q = (data?: unknown, error?: string) => ({ data, loading: false, error, refetch: vi.fn() });

beforeEach(() => {
  results.length = 0;
  call = 0;
});

describe('ObservabilityPage', () => {
  it('renders the not-enabled state when the metrics API is unconfigured', () => {
    results.push(q({ configured: false })); // status
    results.push(q(undefined, 'GET /admin/observability/metrics → 501: not_configured')); // metrics
    render(<ObservabilityPage />);
    expect(screen.getByText(/Live metrics not enabled/i)).toBeInTheDocument();
    expect(screen.getByText(/GATEWAY_METRICS_URL/)).toBeInTheDocument();
  });

  it('renders stat tiles + breakdowns from a metrics summary', () => {
    results.push(q({ configured: true, reachable: true, latencyMs: 4 })); // status
    results.push(
      q({
        metrics: {
          scrapedAt: new Date().toISOString(),
          requests: {
            total: 200,
            byStatus: { ok: 180 },
            byProvider: { anthropic: 100 },
            byModel: {},
            streamedShare: 0.4,
          },
          tokens: { input: 1000, output: 500, byProvider: { anthropic: 1500 } },
          cost: { totalMicroUsd: 123456, savedMicroUsd: { prompt_cache: 4000 }, unpriced: 0 },
          cache: { byStatus: { 'hit-exact': 30, miss: 70 }, hitRatio: 0.3 },
          guardrail: { block: 3 },
          failovers: {},
          budgetAlerts: {},
          duration: { count: 100, avgSeconds: 0.55, p50: 0.4, p90: 0.9, p99: 1.2 },
        },
      }),
    ); // metrics
    render(<ObservabilityPage />);
    expect(screen.getByText('Requests')).toBeInTheDocument();
    expect(screen.getByText('200')).toBeInTheDocument();
    expect(screen.getByText('p50 latency')).toBeInTheDocument();
    expect(screen.getByText('Requests by provider')).toBeInTheDocument();
    expect(screen.getByText(/gateway · 4ms/)).toBeInTheDocument();
  });
});
