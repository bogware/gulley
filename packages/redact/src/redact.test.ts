import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { filterSpanAttributes, scrub, scrubHeaders } from './index';

describe('span + header scrubbing', () => {
  it('keeps only allowlisted span attributes', () => {
    const out = filterSpanAttributes({
      'gen_ai.request.model': 'haiku',
      'gulley.cost.micro_usd': 32,
      'gen_ai.prompt': 'secret user content', // legacy content attr — dropped
      authorization: 'Bearer sk-ant-xyz',
    });
    expect(out).toEqual({ 'gen_ai.request.model': 'haiku', 'gulley.cost.micro_usd': 32 });
  });

  it('drops sensitive headers', () => {
    const out = scrubHeaders({
      'content-type': 'application/json',
      authorization: 'Bearer x',
      'x-api-key': 'sk-ant-x',
      cookie: 'a=b',
    });
    expect(out).toEqual({ 'content-type': 'application/json' });
  });
});

// Fuzz: across three auth-mode labels, inject known-format credential material
// into random structures and assert it never survives scrubbing. Content-scrub
// catches KNOWN secret formats; opaque bearer tokens are defended by the header
// denylist (asserted separately below), not by content scanning.
describe('credential-leak fuzz', () => {
  const CREDS = [
    () => 'sk-ant-api03-' + randomBytes(16).toString('hex'),
    () => 'sk-proj-' + randomBytes(20).toString('hex'),
    () => 'AKIA' + randomBytes(8).toString('hex').toUpperCase().slice(0, 16),
    () => 'ghp_' + randomBytes(20).toString('hex'),
  ];

  it('no known-format credential survives scrub across 600 iterations x 3 modes', () => {
    for (const mode of ['virtual-key', 'oauth-broker', 'passthrough']) {
      for (let i = 0; i < 200; i++) {
        const cred = (CREDS[i % CREDS.length] ?? CREDS[0])!();
        const payload = {
          mode,
          note: `request used ${cred}`,
          nested: [{ inner: cred }, { ok: 'clean' }],
        };
        expect(JSON.stringify(scrub(payload)).includes(cred)).toBe(false);
      }
    }
  });

  it('the header denylist drops credential headers regardless of token format', () => {
    for (let i = 0; i < 100; i++) {
      const opaque = randomBytes(24).toString('base64url'); // opaque bearer secret
      const hdr = scrubHeaders({
        'content-type': 'application/json',
        authorization: `Bearer ${opaque}`,
        'x-api-key': opaque,
        cookie: `sid=${opaque}`,
      });
      expect(JSON.stringify(hdr).includes(opaque)).toBe(false);
      expect(hdr).toEqual({ 'content-type': 'application/json' });
    }
  });
});
