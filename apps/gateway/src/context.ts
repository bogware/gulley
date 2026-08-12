import { AnthropicAdapter, type UpstreamCredential } from '@gulley/providers';
import {
  createDatabase,
  PostgresAuditSink,
  PostgresKeyStore,
  PostgresLedger,
  PostgresRequestLog,
} from '@gulley/storage';
import type { Config } from './config';
import type { GatewayContext } from './routes/messages';

/** Wire the data-plane dependencies from config. Throws if required secrets are
 *  absent — the caller decides whether to boot health-only or fail hard. */
export function createProductionContext(config: Config): GatewayContext {
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required to run the data plane');
  if (!config.GULLEY_KEY_PEPPER) throw new Error('GULLEY_KEY_PEPPER is required to validate keys');
  if (!config.ANTHROPIC_UPSTREAM_API_KEY) {
    throw new Error('ANTHROPIC_UPSTREAM_API_KEY is required to reach Anthropic');
  }

  const db = createDatabase(config.DATABASE_URL);
  const credential: UpstreamCredential = {
    kind: 'api-key',
    value: config.ANTHROPIC_UPSTREAM_API_KEY,
  };

  return {
    adapter: new AnthropicAdapter({ baseUrl: config.ANTHROPIC_BASE_URL }),
    keyStore: new PostgresKeyStore(db),
    pepper: config.GULLEY_KEY_PEPPER,
    credential,
    ledger: new PostgresLedger(db),
    requestLog: new PostgresRequestLog(db),
    audit: new PostgresAuditSink(db),
  };
}
