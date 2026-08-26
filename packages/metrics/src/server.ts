import http from 'node:http';
import { PROMETHEUS_CONTENT_TYPE } from './registry';

export interface MetricsSource {
  render(): string;
}

export interface MetricsServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

export interface MetricsServerOptions {
  metrics: MetricsSource;
  port: number;
  /** Bind address. Default 0.0.0.0 so a scraper/sidecar can reach it. */
  host?: string;
}

/**
 * A dedicated management listener for `/metrics`, separate from the data-plane
 * port so scrape traffic never mixes with client traffic (and can be firewalled
 * independently). Also answers `/health` for liveness. Everything else 404s.
 */
export function startMetricsServer(opts: MetricsServerOptions): Promise<MetricsServerHandle> {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/metrics') {
      res.writeHead(200, { 'content-type': PROMETHEUS_CONTENT_TYPE });
      res.end(opts.metrics.render());
    } else if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
