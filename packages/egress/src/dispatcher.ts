import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { EgressError, isBlockedIp } from './allow';

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `dns.lookup`-compatible resolver that refuses to hand undici an internal,
 * link-local or metadata address. Because undici dials exactly the address this
 * returns, the check is made at CONNECT time on the address actually used — the
 * DNS-rebind defence the structural URL check cannot provide (a public-looking DLP
 * host whose record flips to 169.254.169.254 after the boot-time check).
 */
export function guardedLookup(
  hostname: string,
  options: { all?: boolean; family?: number; hints?: number } | number,
  callback: LookupCallback,
): void {
  const opts = typeof options === 'number' ? { family: options } : (options ?? {});
  dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const list = (Array.isArray(addresses) ? addresses : [addresses]) as LookupAddress[];
    const safe = list.filter((a) => !isBlockedIp(a.address));
    if (safe.length === 0) {
      const e = new EgressError(
        'blocked-ip',
        `${hostname} resolves only to blocked (internal/metadata) addresses`,
      ) as unknown as NodeJS.ErrnoException;
      e.code = 'EEGRESS_BLOCKED';
      return callback(e, '');
    }
    if (opts.all) return callback(null, safe);
    const first = safe[0] as LookupAddress;
    callback(null, first.address, first.family);
  });
}

let agent: Agent | undefined;

/**
 * The shared undici Agent for guarded egress (DLP plugins, external authz, alert
 * webhooks): connects only to addresses `guardedLookup` admits. Pass it as the
 * `dispatcher` of a `fetch`/`request` call. Never used for provider upstreams,
 * which may legitimately be internal (self-hosted models).
 */
export function pinnedEgressAgent(): Agent {
  // undici's option is typed against net.LookupFunction; the runtime contract is
  // dns.lookup's (hostname, options, callback), which guardedLookup honours.
  agent ??= new Agent({ connect: { lookup: guardedLookup as unknown as LookupFunction } });
  return agent;
}

/**
 * A `fetch` bound to the DNS-pinned egress agent — the `fetchImpl` analogue of
 * `pinnedEgressAgent()`, for guarded clients that take a `fetchImpl` rather than a
 * `dispatcher` (OIDC discovery/JWKS/token, Entra Graph, the audit anchor, the eval
 * runner). Connect-time rebind defence: the structural `assertEgressAllowed` URL check
 * cannot see a host whose A-record flips to an internal/metadata address after the check.
 */
export function pinnedFetch(): typeof fetch {
  const dispatcher = pinnedEgressAgent();
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    // `dispatcher` is an undici extension not present in the DOM RequestInit type.
    fetch(input, { ...(init ?? {}), ...({ dispatcher } as object) })) as typeof fetch;
}
