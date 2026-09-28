'use client';

import { Button, Panel, PanelHeader } from '../components/ui';

/** Console-styled 404 (App Router `not-found`), so a bad URL is branded and offers a way
 *  back instead of rendering Next.js's default unstyled page. */
export default function NotFound() {
  return (
    <div className="mx-auto mt-10 max-w-lg">
      <Panel>
        <PanelHeader title="Page not found" />
        <div className="flex flex-col gap-3 p-4 text-[11.5px] text-body">
          <p>That page doesn’t exist in the console.</p>
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => window.location.assign('/')}>
              Back to overview
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
