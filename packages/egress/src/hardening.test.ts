import { describe, expect, it } from 'vitest';
import { assertEgressAllowed, EgressError, isBlockedHostname, isBlockedIp } from './allow';
import { guardedLookup } from './dispatcher';

describe('egress guard — hostnames and IPv6 ranges', () => {
  it('blocks local / metadata names whatever DNS says', () => {
    for (const h of [
      'https://localhost/x',
      'https://api.localhost/x',
      'https://metadata.google.internal/computeMetadata/v1/',
      'https://instance-data/latest/meta-data/',
    ]) {
      expect(() => assertEgressAllowed(h)).toThrow(EgressError);
    }
    expect(isBlockedHostname('example.com')).toBe(false);
  });

  it('covers the whole link-local block, IPv4-compatible and NAT64 forms', () => {
    expect(isBlockedIp('fe80::1')).toBe(true);
    expect(isBlockedIp('fe90::1')).toBe(true); // fe80::/10, not only the fe80 prefix
    expect(isBlockedIp('feb0::1')).toBe(true);
    expect(isBlockedIp('fec0::1')).toBe(false); // site-local is outside fe80::/10
    expect(isBlockedIp('::169.254.169.254')).toBe(true);
    expect(isBlockedIp('::a9fe:a9fe')).toBe(true); // the WHATWG-normalised form
    expect(isBlockedIp('64:ff9b::a9fe:a9fe')).toBe(true); // NAT64 → 169.254.169.254
    expect(isBlockedIp('64:ff9b::808:808')).toBe(false); // NAT64 → 8.8.8.8 (public)
    expect(isBlockedIp('2606:4700::1')).toBe(false);
  });

  it('guardedLookup refuses a name that resolves only to blocked addresses (rebind defence)', async () => {
    const err = await new Promise<Error | null>((resolve) =>
      guardedLookup('localhost', { family: 0 }, (e) => resolve(e)),
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe('EEGRESS_BLOCKED');
  });
});
