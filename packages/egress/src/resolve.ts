import { lookup } from 'node:dns/promises';
import { EgressError, isBlockedIp, isIpLiteral } from './allow';

/**
 * DNS-rebind defense: resolve a hostname and reject if ANY resolved address is
 * internal/link-local/metadata — a public-looking name that points at
 * 169.254.169.254 or RFC1918. Complements the structural literal check in
 * `assertEgressAllowed`. (Prod wires this at undici connect time so the checked
 * address is the one actually dialed.)
 */
export async function assertHostResolvesPublic(host: string): Promise<void> {
  if (isIpLiteral(host)) {
    if (isBlockedIp(host)) throw new EgressError('blocked-ip', `blocked address literal: ${host}`);
    return;
  }
  const results = await lookup(host, { all: true });
  for (const r of results) {
    if (isBlockedIp(r.address)) {
      throw new EgressError('blocked-ip', `${host} resolves to a blocked address: ${r.address}`);
    }
  }
}
