import { secretRef } from '@gulley/core';
import { describe, expect, it } from 'vitest';
import { InMemoryAuditSink } from './memory';
import {
  assertNoInlineSecret,
  GuardedAuditSink,
  InlineSecretError,
  redactAuditRow,
} from './sanitize';

const ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:gulley/openai-Ab12Cd';

describe('assertNoInlineSecret', () => {
  it('throws on inline secret values (any key, nested, arrays)', () => {
    expect(() => assertNoInlineSecret({ apiKey: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAA' })).toThrow(
      InlineSecretError,
    );
    expect(() => assertNoInlineSecret({ note: 'AKIAIOSFODNN7EXAMPLE' })).toThrow(InlineSecretError);
    expect(() => assertNoInlineSecret({ a: { b: ['ghp_' + 'x'.repeat(36)] } })).toThrow(
      InlineSecretError,
    );
  });

  it('throws on a secret-named field holding a raw value (value-smuggle)', () => {
    expect(() => assertNoInlineSecret({ keyHash: 'a'.repeat(64) })).toThrow(InlineSecretError);
    expect(() => assertNoInlineSecret({ pepper: 'not-obviously-a-secret' })).toThrow(
      InlineSecretError,
    );
  });

  it('throws when a SecretRef smuggles a value into secretArn', () => {
    expect(() =>
      assertNoInlineSecret({
        credential: { secretArn: 'sk-ant-api03-XXXXXXXXXXXXXXXXXXXX', secretVersion: 'v1' },
      }),
    ).toThrow(InlineSecretError);
  });

  it('allows a well-formed SecretRef and ordinary hashes', () => {
    expect(() => assertNoInlineSecret({ credential: secretRef(ARN, 'v1') })).not.toThrow();
    // sha256 chain fields are NOT secrets and must pass.
    expect(() =>
      assertNoInlineSecret({
        rowHash: 'f'.repeat(64),
        prevHash: 'a'.repeat(64),
        contentHash: 'b'.repeat(64),
      }),
    ).not.toThrow();
  });
});

describe('redactAuditRow + GuardedAuditSink', () => {
  it('redacts secrets without throwing and keeps refs', () => {
    const out = redactAuditRow({
      apiKey: 'sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZ',
      model: 'haiku',
      ref: secretRef(ARN, 'v1'),
    });
    expect(out['apiKey']).toBe('[REDACTED]');
    expect(out['model']).toBe('haiku');
    expect(out['ref']).toMatchObject({ secretArn: ARN });
  });

  it('the guarded sink redacts, counts a violation, and keeps the chain intact', async () => {
    const inner = new InMemoryAuditSink();
    const sink = new GuardedAuditSink(inner);
    await sink.append({
      actor: 'a',
      action: 'key.mint',
      payload: { token: 'sk-ant-api03-LEAKLEAKLEAKLEAKLEAK' },
    });
    await sink.append({ actor: 'a', action: 'org.create', payload: { name: 'Acme' } });
    expect(sink.violations).toBe(1);
    expect(inner.rows[0]?.payload?.['token']).toBe('[REDACTED]');
    expect(inner.verify()).toBe(true);
  });
});
