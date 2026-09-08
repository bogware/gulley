'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useAdmin } from '../lib/admin-context';
import { useAdminQuery } from '../lib/hooks';
import { TokenGate } from './token-gate';
import { cx, Dot, Spinner } from './ui';

interface NavItem {
  href: string;
  label: string;
}
const NAV_GROUPS: Array<{ group: string; items: NavItem[] }> = [
  {
    group: 'Observe',
    items: [
      { href: '/', label: 'Overview' },
      { href: '/logs', label: 'Request logs' },
      { href: '/analytics', label: 'Analytics' },
      { href: '/observability', label: 'Observability' },
    ],
  },
  {
    group: 'Govern',
    items: [
      { href: '/compliance', label: 'Compliance & WORM' },
      { href: '/guardrails', label: 'Guardrails' },
      { href: '/rollouts', label: 'Eval rollouts' },
    ],
  },
  {
    group: 'FinOps',
    items: [
      { href: '/finops', label: 'Chargeback & bypass' },
      { href: '/budgets', label: 'Budgets' },
      { href: '/rate-limits', label: 'Rate limits' },
    ],
  },
  {
    group: 'Identity',
    items: [
      { href: '/identity', label: 'Users & sessions' },
      { href: '/keys', label: 'Virtual keys' },
    ],
  },
  {
    group: 'Configure',
    items: [
      { href: '/config', label: 'Config console' },
      { href: '/routes', label: 'Routes & aliases' },
      { href: '/providers', label: 'Providers' },
      { href: '/prompts', label: 'Prompts' },
      { href: '/orgs', label: 'Orgs & workspaces' },
      { href: '/settings', label: 'Settings & status' },
    ],
  },
];

function AuditStatus() {
  const q = useAdminQuery((api) => api.verifyAudit(), []);
  const verified = q.data?.verified;
  return (
    <div className="flex items-center gap-1.5">
      <Dot tone={q.loading ? 'amber' : verified ? 'green' : 'red'} />
      <span className="font-mono text-2xs text-secondary">
        audit chain ·{' '}
        {q.loading ? '…' : verified ? `verified (${q.data?.count ?? 0})` : 'unverified'}
      </span>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { authed, ready, setToken } = useAdmin();
  const pathname = usePathname();

  if (!ready) {
    return (
      <div className="p-10">
        <Spinner />
      </div>
    );
  }
  if (!authed) return <TokenGate />;

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-[214px] shrink-0 flex-col border-r border-line-control bg-sidebar shadow-[inset_-1px_0_0_#F7F4ED]">
        {/* wordmark */}
        <div className="border-b border-[#C9C2B3] px-3.5 py-3">
          <div className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Gulley</div>
          <div className="mt-0.5 font-mono text-[10px] text-secondary">v1.14.2 · self-hosted</div>
        </div>

        {/* nav groups */}
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {NAV_GROUPS.map((g) => (
            <div key={g.group} className="mb-3">
              <div className="px-2 pb-1.5 text-[9px] font-medium uppercase tracking-[0.14em] text-micro">
                {g.group}
              </div>
              <div className="flex flex-col gap-px">
                {g.items.map((n) => {
                  const active = pathname === n.href;
                  return (
                    <Link
                      key={n.href}
                      href={n.href}
                      className={cx(
                        'flex items-center gap-2 rounded-control px-2 py-[5px] text-[12.5px] transition-colors duration-[120ms]',
                        active ? 'bg-ink font-medium text-[#F6F3EC]' : 'text-body hover:bg-rail',
                      )}
                    >
                      <span
                        className="h-[5px] w-[5px] shrink-0"
                        style={{ background: active ? '#C9A227' : '#BDB6A6' }}
                      />
                      {n.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* footer status */}
        <div className="mt-auto border-t border-[#C9C2B3] px-3.5 py-3">
          <div className="flex items-center gap-1.5">
            <Dot tone="green" />
            <span className="font-mono text-2xs text-secondary">control API · connected</span>
          </div>
          <div className="mt-1">
            <AuditStatus />
          </div>
          <div className="mt-2.5 flex items-center justify-between rounded-control border border-line-control bg-panel px-2 py-1">
            <span className="font-mono text-[10px] text-body">admin · session</span>
            <button
              onClick={() => setToken(null)}
              className="text-[10px] text-secondary transition-colors hover:text-err-text"
            >
              Disconnect
            </button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-5 py-4">{children}</main>
    </div>
  );
}
