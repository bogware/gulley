import { describe, expect, it } from 'vitest';
import {
  CompositeConfigNotifier,
  type ConfigNotifier,
  type ConfigSignal,
  InMemoryConfigBus,
  newOriginId,
  parseSignal,
  SignalGate,
} from './pubsub';

const sig = (over: Partial<ConfigSignal> = {}): ConfigSignal => ({
  v: 1,
  hash: 'h',
  origin: 'other',
  ts: 0,
  ...over,
});

describe('SignalGate', () => {
  it('accepts new foreign signals monotonically and dedupes replays', () => {
    const gate = new SignalGate('me');
    expect(gate.accept(sig({ v: 1 }))).toBe(true);
    expect(gate.accept(sig({ v: 1 }))).toBe(false); // duplicate version
    expect(gate.accept(sig({ v: 2 }))).toBe(true);
    expect(gate.accept(sig({ v: 2 }))).toBe(false);
    expect(gate.accept(sig({ v: 1 }))).toBe(false); // out-of-order older
    expect(gate.appliedVersion).toBe(2);
  });

  it('ignores its own emissions (self-notification guard)', () => {
    const gate = new SignalGate('me', 0);
    expect(gate.accept(sig({ v: 5, origin: 'me' }))).toBe(false);
    expect(gate.appliedVersion).toBe(0); // cursor untouched
    expect(gate.accept(sig({ v: 5, origin: 'other' }))).toBe(true);
  });

  it('observe() advances the cursor from a durable read (reconnect catch-up)', () => {
    const gate = new SignalGate('me');
    gate.observe(10);
    expect(gate.appliedVersion).toBe(10);
    expect(gate.accept(sig({ v: 8 }))).toBe(false); // already past it
    expect(gate.accept(sig({ v: 11 }))).toBe(true);
    gate.observe(5); // never goes backwards
    expect(gate.appliedVersion).toBe(11);
  });
});

describe('parseSignal', () => {
  it('parses a valid signal and rejects malformed payloads', () => {
    expect(parseSignal(JSON.stringify(sig({ v: 3 })))).toMatchObject({ v: 3, origin: 'other' });
    expect(parseSignal('not json')).toBeUndefined();
    expect(parseSignal(JSON.stringify({ v: 'x', hash: 'h', origin: 'o' }))).toBeUndefined();
    expect(parseSignal(JSON.stringify({ hash: 'h', origin: 'o' }))).toBeUndefined();
  });
});

describe('newOriginId', () => {
  it('mints distinct ids', () => {
    expect(newOriginId()).not.toBe(newOriginId());
  });
});

describe('CompositeConfigNotifier', () => {
  it('fans one emit to every transport and a failing one never blocks the rest', async () => {
    const seen: string[] = [];
    const ok = (tag: string): ConfigNotifier => ({
      emit: async (s) => void seen.push(`${tag}:${s.v}`),
    });
    const boom: ConfigNotifier = {
      emit: async () => {
        throw new Error('down');
      },
    };
    const composite = new CompositeConfigNotifier([ok('a'), boom, ok('b')]);
    await composite.emit(sig({ v: 7 }));
    expect(seen).toEqual(['a:7', 'b:7']);
  });
});

describe('InMemoryConfigBus + SignalGate integration', () => {
  it('delivers foreign signals and drops self/duplicate through the gate', async () => {
    const bus = new InMemoryConfigBus();
    const gate = new SignalGate('me');
    const applied: number[] = [];
    bus.onSignal((s) => {
      if (gate.accept(s)) applied.push(s.v);
    });
    await bus.start();

    await bus.emit(sig({ v: 1, origin: 'me' })); // self → dropped
    await bus.emit(sig({ v: 1, origin: 'peer' })); // applied
    await bus.emit(sig({ v: 1, origin: 'peer' })); // duplicate → dropped (dual bus)
    await bus.emit(sig({ v: 2, origin: 'peer' })); // applied
    expect(applied).toEqual([1, 2]);
    await bus.close();
  });
});
