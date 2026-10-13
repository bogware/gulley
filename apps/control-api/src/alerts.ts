import {
  AlertDispatcher,
  type AlertLogger,
  type AlertSink,
  noopAlertSink,
  parseAlertChannels,
} from '@gulley/alerts';
import { pinnedFetch } from '@gulley/egress';
import { type Config, outboundAllowlist } from './config';

/**
 * The alert sink from `ALERT_CHANNELS`. Every channel target goes through the SAME
 * egress guard as the other control-plane outbounds (the outbound allowlist, https
 * outside development, the air-gapped posture) at construction, so a bad channel
 * fails boot instead of failing silently on the first alert; the fetch itself is
 * DNS-pinned. Unset or empty ⇒ the no-op sink.
 */
export function buildAlertSink(
  config: Config,
  opts: { log?: AlertLogger; fetchImpl?: typeof fetch; source?: string } = {},
): AlertSink {
  if (!config.ALERT_CHANNELS) return noopAlertSink;
  const channels = parseAlertChannels(config.ALERT_CHANNELS);
  if (channels.length === 0) return noopAlertSink;
  return new AlertDispatcher({
    channels,
    egress: {
      allowlist: outboundAllowlist(config),
      requireHttps: config.NODE_ENV !== 'development',
      airGapped: config.AIR_GAPPED,
    },
    fetchImpl: opts.fetchImpl ?? pinnedFetch(), // connect-time DNS-rebind defence
    source: opts.source ?? 'gulley-control-api',
    log: opts.log,
  });
}
