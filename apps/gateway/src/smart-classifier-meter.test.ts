import { InMemoryBudgetStore } from '@gulley/budget';
import { InMemoryAuditSink, InMemoryLedger } from '@gulley/pipeline';
import type { ClassifierUsage } from '@gulley/routing';
import { describe, expect, it } from 'vitest';
import { type ClassifierMeterDeps, meterClassifierSpend } from './smart-classifier-meter';

const usage: ClassifierUsage = {
  provider: 'anthropic',
  model: 'router-x',
  inputTokens: 20,
  outputTokens: 1,
};
const principal = { id: 'vk_1', orgId: 'org_1', workspaceId: 'ws_1' };

describe('meterClassifierSpend', () => {
  it('records a proxy.classify ledger + audit line on a derived #classify id', async () => {
    const ledger = new InMemoryLedger();
    const audit = new InMemoryAuditSink();
    const deps: ClassifierMeterDeps = {
      budgets: new InMemoryBudgetStore(new Map([['ws_1', { capMicroUsd: 1_000_000 }]])),
      ledger,
      audit,
    };
    await meterClassifierSpend(deps, principal, 'req_1', usage);

    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({
      requestId: 'req_1#classify',
      provider: 'anthropic',
      model: 'router-x',
      workspaceId: 'ws_1',
    });
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ action: 'proxy.classify', actor: 'vk_1' });
    expect(audit.rows[0]?.payload).toMatchObject({ inputTokens: 20, outputTokens: 1 });
  });

  it('is fail-open: a metering-sink error never throws into the served request', async () => {
    const deps: ClassifierMeterDeps = {
      budgets: new InMemoryBudgetStore(new Map()),
      ledger: {
        record: async () => {
          throw new Error('ledger down');
        },
      },
      audit: {
        append: async () => {
          throw new Error('audit down');
        },
      },
    };
    await expect(meterClassifierSpend(deps, principal, 'req_1', usage)).resolves.toBeUndefined();
  });

  it('does NOT commit when the workspace has no budget (reserve → null), but still records', async () => {
    const commits: number[] = [];
    const ledger = new InMemoryLedger();
    const audit = new InMemoryAuditSink();
    const deps: ClassifierMeterDeps = {
      budgets: {
        reserve: async () => null,
        commit: async (_ws, _id, micro) => {
          commits.push(micro);
        },
      },
      ledger,
      audit,
    };
    await meterClassifierSpend(deps, principal, 'req_1', usage);
    expect(commits).toHaveLength(0); // no reservation ⇒ no commit (matches the served path)
    expect(ledger.entries).toHaveLength(1); // attribution still recorded
    expect(audit.rows[0]?.action).toBe('proxy.classify');
  });

  it('records the line but does NOT commit when over budget (reserve denied)', async () => {
    const commits: number[] = [];
    const audit = new InMemoryAuditSink();
    const deps: ClassifierMeterDeps = {
      budgets: {
        reserve: async () => ({ allowed: false, capMicroUsd: 1, usedMicroUsd: 1 }),
        commit: async (_ws, _id, micro) => {
          commits.push(micro);
        },
      },
      ledger: new InMemoryLedger(),
      audit,
    };
    await meterClassifierSpend(deps, principal, 'req_1', usage);
    expect(commits).toHaveLength(0);
    expect(audit.rows[0]?.action).toBe('proxy.classify');
  });

  it('is fail-open when the rateResolver throws — no ledger/audit line, no throw', async () => {
    const ledger = new InMemoryLedger();
    const audit = new InMemoryAuditSink();
    const deps: ClassifierMeterDeps = {
      budgets: new InMemoryBudgetStore(new Map()),
      ledger,
      audit,
      rateResolver: () => {
        throw new Error('boom');
      },
    };
    await expect(meterClassifierSpend(deps, principal, 'req_1', usage)).resolves.toBeUndefined();
    expect(ledger.entries).toHaveLength(0); // costing threw before anything was recorded
    expect(audit.rows).toHaveLength(0);
  });
});
