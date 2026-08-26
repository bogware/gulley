import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppShell } from '../components/app-shell';
import { AdminProvider } from '../lib/admin-context';
import './globals.css';

export const metadata: Metadata = {
  title: 'Gulley Console',
  description: 'Gulley — enterprise LLM gateway control plane',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
        <AdminProvider>
          <AppShell>{children}</AppShell>
        </AdminProvider>
      </body>
    </html>
  );
}
