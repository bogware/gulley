import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { initAccessLogExporter } from './access-log-exporter';

/**
 * Stands up a throwaway OTLP/HTTP collector so the test exercises the real wire
 * path (protobuf POST to /v1/logs) rather than a mock, and proves shutdown() resolves
 * promptly once the batch is delivered — the property the SIGTERM drain relies on.
 */
function collector(): Promise<{
  server: Server;
  url: string;
  requests: Array<{ path: string; contentType: string | undefined; body: Buffer }>;
}> {
  const requests: Array<{ path: string; contentType: string | undefined; body: Buffer }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({
        path: req.url ?? '',
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks),
      });
      res.writeHead(200, { 'content-type': 'application/x-protobuf' });
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, requests });
    });
  });
}

describe('initAccessLogExporter', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it('returns undefined without an endpoint (disabled)', () => {
    expect(initAccessLogExporter({ endpoint: undefined })).toBeUndefined();
  });

  it('flattens a nested, credential-free record and delivers it to /v1/logs; shutdown resolves once flushed', async () => {
    const c = await collector();
    server = c.server;
    const sink = initAccessLogExporter({ endpoint: `${c.url}/`, serviceName: 'test' });
    expect(sink).toBeDefined();
    // Nested objects/arrays are flattened to scalar attributes; must not throw.
    expect(() =>
      sink!.emit({
        requestId: 'req_1',
        statusCode: 200,
        streamed: true,
        principal: { id: 'vk_1', orgId: 'org_1' },
        tags: ['a', 'b'],
      }),
    ).not.toThrow();
    const started = Date.now();
    await sink!.shutdown();
    expect(Date.now() - started).toBeLessThan(4_000);

    expect(c.requests).toHaveLength(1);
    const [req] = c.requests;
    expect(req!.path).toBe('/v1/logs');
    expect(req!.contentType).toContain('application/json');
    // OTLP/JSON: resource carries the service name; the single record carries the
    // flattened attributes (nested keys dotted, array items indexed).
    const wire = JSON.parse(req!.body.toString('utf8')) as {
      resourceLogs: Array<{
        resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
        scopeLogs: Array<{
          logRecords: Array<{
            body: { stringValue?: string };
            attributes: Array<{ key: string; value: Record<string, unknown> }>;
          }>;
        }>;
      }>;
    };
    const resource = wire.resourceLogs[0]!.resource.attributes;
    expect(resource.find((a) => a.key === 'service.name')?.value.stringValue).toBe('test');
    const records = wire.resourceLogs[0]!.scopeLogs.flatMap((s) => s.logRecords);
    expect(records).toHaveLength(1);
    expect(records[0]!.body.stringValue).toBe('access');
    const keys = records[0]!.attributes.map((a) => a.key).sort();
    expect(keys).toEqual(
      [
        'principal.id',
        'principal.orgId',
        'requestId',
        'statusCode',
        'streamed',
        'tags.0',
        'tags.1',
      ].sort(),
    );
  });

  it('shutdown() is bounded when the collector is unreachable (never blocks a drain)', async () => {
    // A closed port: the export fails fast or exhausts its bounded retry budget.
    const c = await collector();
    const url = c.url;
    await new Promise<void>((r) => c.server.close(() => r()));
    const sink = initAccessLogExporter({ endpoint: url, serviceName: 'test' });
    sink!.emit({ requestId: 'req_dead', statusCode: 502 });
    const started = Date.now();
    await expect(sink!.shutdown()).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 10_000);
});
