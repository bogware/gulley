import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { flatten } from './access-log';
import { EXPORT_TIMEOUT_MS } from './otel';

/**
 * Ships each per-request access-log record to an OTLP logs backend as a
 * structured `LogRecord`, so the operator-configured access log is queryable in
 * the same place as spans + metrics (not only in the container's stdout). Export
 * is batched + bounded (drops rather than back-pressuring the hot path), exactly
 * like the span exporter. The record is credential-free by construction (the
 * gateway builds it that way); this only flattens it to OTLP scalar attributes.
 */
export interface AccessLogSink {
  emit(record: Record<string, unknown>): void;
  shutdown(): Promise<void>;
}

/** OTLP LogRecord attribute values must be scalars/arrays — coerce anything else. */
function toAttrs(record: Record<string, unknown>): Record<string, string | number | boolean> {
  const flat = flatten(record);
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(flat)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (v != null) out[k] = JSON.stringify(v);
  }
  return out;
}

export function initAccessLogExporter(opts: {
  endpoint?: string | undefined;
  serviceName?: string;
}): AccessLogSink | undefined {
  if (!opts.endpoint) return undefined;
  // Bounded export: a dead/slow collector must never hold the SIGTERM drain hostage
  // (the OTLP transport retries transient failures with backoff up to this budget,
  // and shutdown() awaits the final flush) — so cap both the per-request timeout and
  // the processor's export budget well inside the drain window.
  const exporter = new OTLPLogExporter({
    url: `${opts.endpoint.replace(/\/$/, '')}/v1/logs`,
    timeoutMillis: EXPORT_TIMEOUT_MS,
  });
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ 'service.name': opts.serviceName ?? 'gulley-gateway' }),
    processors: [
      new BatchLogRecordProcessor({
        exporter,
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 1000,
        exportTimeoutMillis: EXPORT_TIMEOUT_MS,
      }),
    ],
  });
  logs.setGlobalLoggerProvider(provider);
  const logger = provider.getLogger('gulley-access-log');
  return {
    emit(record: Record<string, unknown>): void {
      logger.emit({
        severityNumber: SeverityNumber.INFO,
        body: 'access',
        attributes: toAttrs(record),
      });
    },
    shutdown: () => provider.shutdown(),
  };
}
