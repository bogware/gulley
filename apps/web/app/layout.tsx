import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import type { ReactNode } from 'react';
import { AppShell } from '../components/app-shell';
import { AdminProvider } from '../lib/admin-context';
import './globals.css';

// Self-hosted (next/font downloads at build, serves from the app — no runtime CDN).
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
  display: 'swap',
});
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Gulley Console',
  description: 'Gulley — enterprise LLM gateway control plane',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable}`}>
      <body className="min-h-screen bg-canvas font-sans text-data text-body antialiased">
        <AdminProvider>
          <AppShell>{children}</AppShell>
        </AdminProvider>
      </body>
    </html>
  );
}
