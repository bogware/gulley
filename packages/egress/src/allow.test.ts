import { afterEach, describe, expect, it } from 'vitest';
import {
  assertEgressAllowed,
  EgressError,
  isAirGappedEgress,
  isBlockedIp,
  setAirGappedEgress,
} from './allow';

describe('isBlockedIp', () => {
  it('blocks metadata, RFC1918, loopback, CGNAT, and IPv6 internals', () => {
    for (const ip of [
      '169.254.169.254', // IMDS
      '169.254.170.2', // ECS metadata
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '127.0.0.1',
      '100.64.0.1',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe', // hex-form IPv4-mapped IMDS — what new URL() actually emits
      '::ffff:7f00:1', // hex-form 127.0.0.1
      '[::ffff:a9fe:a9fe]',
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows public addresses and hostnames', () => {
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('api.anthropic.com')).toBe(false);
  });
});

describe('assertEgressAllowed', () => {
  it('blocks IMDS even over https', () => {
    expect(() => assertEgressAllowed('https://169.254.169.254/latest/meta-data/')).toThrow(
      EgressError,
    );
  });

  it('rejects non-https, userinfo, and non-allowlisted hosts', () => {
    expect(() => assertEgressAllowed('http://api.anthropic.com')).toThrow(/non-https/);
    expect(() => assertEgressAllowed('https://user:pass@api.anthropic.com')).toThrow(/credentials/);
    expect(() =>
      assertEgressAllowed('https://evil.example', { allowlist: ['api.anthropic.com'] }),
    ).toThrow(/allowlist/);
  });

  it('allows an allowlisted https host and returns the URL', () => {
    const url = assertEgressAllowed('https://api.anthropic.com/v1/messages', {
      allowlist: ['api.anthropic.com'],
    });
    expect(url.hostname).toBe('api.anthropic.com');
  });
});

describe('air-gapped egress posture', () => {
  afterEach(() => setAirGappedEgress(false)); // never leak the process-wide default

  it('normally allows any non-blocked public host with no allowlist', () => {
    expect(assertEgressAllowed('https://api.anthropic.com').hostname).toBe('api.anthropic.com');
  });

  it('per-call airGapped denies a host when no allowlist is given', () => {
    expect(() => assertEgressAllowed('https://api.anthropic.com', { airGapped: true })).toThrow(
      /air-gapped/,
    );
  });

  it('per-call airGapped still permits an explicitly allowlisted host', () => {
    const url = assertEgressAllowed('https://dlp.acme.internal/scan', {
      airGapped: true,
      allowlist: ['dlp.acme.internal'],
    });
    expect(url.hostname).toBe('dlp.acme.internal');
    // ...and still rejects one that is NOT on the allowlist.
    expect(() =>
      assertEgressAllowed('https://evil.example', {
        airGapped: true,
        allowlist: ['dlp.acme.internal'],
      }),
    ).toThrow(/allowlist/);
  });

  it('the process-wide default hardens every call, and can be turned back off', () => {
    setAirGappedEgress(true);
    expect(isAirGappedEgress()).toBe(true);
    expect(() => assertEgressAllowed('https://api.anthropic.com')).toThrow(/air-gapped/);
    // An explicit per-call override still wins over the default.
    expect(assertEgressAllowed('https://api.anthropic.com', { airGapped: false }).hostname).toBe(
      'api.anthropic.com',
    );
    setAirGappedEgress(false);
    expect(assertEgressAllowed('https://api.anthropic.com').hostname).toBe('api.anthropic.com');
  });
});
