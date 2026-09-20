'use client';

import { useEffect } from 'react';
import { Button, Panel, PanelHeader } from '../components/ui';

/**
 * Route-segment error boundary (Next.js App Router). A thrown render/effect error
 * used to blank the whole console; now it is caught per page with a retry and the
 * detail kept out of the UI (the browser console has it).
 */
export default function ErrorBoundary({
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
    <div className="mx-auto mt-10 max-w-lg">
      <Panel>
        <PanelHeader title="This page hit an error" meta={error.digest ?? undefined} />
        <div className="flex flex-col gap-3 p-4 text-[11.5px] text-body">
          <p>
            The console could not render this page. The rest of the console still works; retry, or
            navigate elsewhere. If it keeps happening, quote the digest above to an operator.
          </p>
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => reset()}>
              Retry
            </Button>
            <Button variant="ghost" onClick={() => window.location.assign('/')}>
              Back to overview
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
