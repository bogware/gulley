import { describe, expect, it } from 'vitest';
import { initAccessLogExporter } from './access-log-exporter';

describe('initAccessLogExporter', () => {
  it('returns undefined without an endpoint (disabled)', () => {
    expect(initAccessLogExporter({ endpoint: undefined })).toBeUndefined();
  });

  it('builds a sink that accepts a nested, credential-free record without throwing', async () => {
    const sink = initAccessLogExporter({ endpoint: 'http://localhost:4318', serviceName: 'test' });
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
    await sink!.shutdown();
  });
});
