import { describe, expect, it } from 'vitest';
import { assertEgressAllowed, EgressError, isBlockedIp } from './allow';

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
