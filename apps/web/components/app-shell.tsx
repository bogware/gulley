'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useAdmin } from '../lib/admin-context';
import { TokenGate } from './token-gate';
import { Spinner } from './ui';

const NAV: Array<{ href: string; label: string }> = [
  { href: '/', label: 'Dashboard' },
  { href: '/logs', label: 'Request logs' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/keys', label: 'Virtual keys' },
  { href: '/providers', label: 'Providers' },
  { href: '/orgs', label: 'Orgs & workspaces' },
  { href: '/budgets', label: 'Budgets' },
  { href: '/rate-limits', label: 'Rate limits' },
  { href: '/guardrails', label: 'Guardrails' },
  { href: '/audit', label: 'Audit' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { token, ready, setToken } = useAdmin();
  const pathname = usePathname();

  if (!ready) {
    return (
      <div className="p-10">
        <Spinner />
      </div>
    );
  }
  if (!token) return <TokenGate />;

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 shrink-0 border-r border-neutral-200 p-4 dark:border-neutral-800">
        <div className="mb-6 px-2 text-lg font-semibold tracking-tight">Gulley</div>
        <nav className="space-y-0.5">
          {NAV.map((n) => {
            const active = pathname === n.href;
            return (
              <Link
                key={n.href}
                href={n.href}
                className={
                  active
                    ? 'block rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-medium dark:bg-neutral-800'
                    : 'block rounded-lg px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-800/60'
                }
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <button
          onClick={() => setToken(null)}
          className="mt-6 px-3 text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
        >
          Disconnect
        </button>
      </aside>
      <main className="min-w-0 flex-1 px-8 py-8">{children}</main>
    </div>
  );
}
