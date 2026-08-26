// k6 load profile for a DEPLOYED Gulley gateway.
//
// Encodes the same SLOs as ops/prometheus/gulley-slo-alerts.yml and the M13
// Grafana dashboard: availability 99.5% (error ratio < 0.005) and p99 end-to-end
// latency < 10s. k6 fails the run (non-zero exit) if a threshold is breached, so
// this doubles as a pre-release gate against a staging deploy.
//
// Run (k6 must be installed — https://k6.io):
//   GATEWAY_URL=https://gateway.example.com \
//   GATEWAY_KEY=gk_... \
//   MODEL=claude-sonnet-4-6 \
//   k6 run ops/load/gateway-load.js
//
// Tunables (env): VUS (50), DURATION (1m), P99_MS (10000), MAX_ERROR_RATIO (0.005).
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

const GATEWAY_URL = __ENV.GATEWAY_URL || 'http://localhost:8080';
const GATEWAY_KEY = __ENV.GATEWAY_KEY || '';
const MODEL = __ENV.MODEL || 'claude-sonnet-4-6';
const P99_MS = Number(__ENV.P99_MS || 10000);
const MAX_ERROR_RATIO = Number(__ENV.MAX_ERROR_RATIO || 0.005);

// Only 5xx / transport failures burn the availability budget (a 4xx is a client
// error and is status="ok" in the SLO), mirroring the Prometheus recording rule.
const serverErrors = new Rate('server_errors');

export const options = {
  vus: Number(__ENV.VUS || 50),
  duration: __ENV.DURATION || '1m',
  thresholds: {
    http_req_duration: [`p(99)<${P99_MS}`],
    server_errors: [`rate<${MAX_ERROR_RATIO}`],
  },
};

export default function () {
  const res = http.post(
    `${GATEWAY_URL}/v1/messages`,
    JSON.stringify({
      model: MODEL,
      max_tokens: 32,
      stream: true,
      messages: [{ role: 'user', content: 'ping' }],
    }),
    {
      headers: {
        'content-type': 'application/json',
        'x-api-key': GATEWAY_KEY,
        'anthropic-version': '2023-06-01',
      },
    },
  );
  serverErrors.add(res.status >= 500 || res.status === 0);
  check(res, { 'status < 500': (r) => r.status < 500 });
}
