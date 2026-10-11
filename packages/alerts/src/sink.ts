import type { AlertEvent } from './types';

/**
 * The emit side of alerting. `emit` is fire-and-forget: it NEVER throws and never
 * awaits anything in the caller's path, so a slow or failing channel can't touch a
 * request (the gateway calls it from the hot path) or an admin write.
 */
export interface AlertSink {
  emit(event: AlertEvent): void;
}

/** The default sink when no channels are configured. */
export const noopAlertSink: AlertSink = {
  emit(): void {
    /* no channels */
  },
};

/** One channel's outcome for a synchronous probe (the admin test endpoint). */
export interface AlertProbeResult {
  /** The channel label (its `type`, or `type#n` when a type repeats; a configured
   *  `name` wins). Never the URL. */
  channel: string;
  type: string;
  ok: boolean;
  attempts: number;
  /** True when the channel's event/severity filter would have skipped this event in
   *  normal operation (the probe delivers regardless, to prove the channel works). */
  filtered: boolean;
  error?: string;
}

/** A sink that can also deliver one event synchronously and report per channel. */
export interface AlertProbe {
  probe(event: AlertEvent): Promise<AlertProbeResult[]>;
}

export function isAlertProbe(sink: AlertSink): sink is AlertSink & AlertProbe {
  return typeof (sink as Partial<AlertProbe>).probe === 'function';
}
