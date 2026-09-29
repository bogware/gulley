'use client';

import { useEffect } from 'react';

/**
 * Root error boundary (App Router `global-error`). Unlike `error.tsx` (which only wraps a
 * page segment) this also catches a throw in the ROOT layout — AppShell / AdminProvider —
 * which sits outside the per-page boundary, so a provider crash shows this instead of
 * Next.js's unstyled default. It replaces the root layout, so it must render its own
 * <html>/<body>; styles are inline so it renders even if the CSS pipeline is what failed.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error(error);
  }, [error]);
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, -apple-system, sans-serif', margin: 0, padding: 24 }}>
        <div style={{ maxWidth: 520, margin: '80px auto' }}>
          <h1 style={{ fontSize: 18, marginBottom: 8 }}>The console failed to load</h1>
          <p style={{ fontSize: 14, lineHeight: 1.5 }}>
            A top-level error stopped the admin console from rendering. Retry, and if it keeps
            happening quote this digest to an operator
            {error.digest ? `: ${error.digest}` : ''}.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              marginTop: 16,
              padding: '8px 14px',
              fontSize: 14,
              cursor: 'pointer',
              borderRadius: 6,
              border: '1px solid #888',
              background: '#f5f5f5',
            }}
          >
            Retry
          </button>
        </div>
      </body>
    </html>
  );
}
