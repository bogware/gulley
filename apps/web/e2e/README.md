# Console E2E (Playwright)

Two layers, both driven by `playwright.config.ts`:

## Smoke (no backend)

`e2e/smoke.spec.ts` boots the production build and asserts the Platinum shell + sign-in
render (IBM Plex loaded, warm-platinum canvas, the token gate). It self-hosts the app on
:3100 and needs no control-api — it runs anywhere `next build` has succeeded.

```bash
pnpm --filter @gulley/web build
pnpm --filter @gulley/web e2e:install   # one-time: the Chromium binary
pnpm --filter @gulley/web e2e --grep smoke
```

## Full flows (seeded backend)

`e2e/flows/*.spec.ts` sign in with a real admin token and navigate every route, asserting
each page mounts and renders its header. They are **skipped** unless `E2E_ADMIN_TOKEN` is
set. Point the run at a seeded stack:

```bash
# with a running control-api (seed orgs/workspaces/providers/keys first) and the web app
export NEXT_PUBLIC_CONTROL_API_URL=https://<control-api>       # or the /control proxy
export E2E_ADMIN_TOKEN=<a bootstrap or session token>
export PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000               # an already-running web app
pnpm --filter @gulley/web e2e
```

The full flows are the CI target once a seeded control-api fixture is stood up; the smoke
layer is safe to run in any build job.
