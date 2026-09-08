import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config for the Gulley admin console.
 *
 * The `smoke` project runs with NO backend — it boots the production build and asserts
 * the console shell + sign-in render (fonts, Platinum styling, the token gate). It runs
 * anywhere `next build` succeeded.
 *
 * The full flows (sign-in → navigate every page → create/edit/delete/revoke/apply) need a
 * seeded control-api + Postgres; point PLAYWRIGHT_BASE_URL / NEXT_PUBLIC_CONTROL_API_URL at
 * a running stack and set E2E_ADMIN_TOKEN. Those specs live under e2e/flows and are skipped
 * unless E2E_ADMIN_TOKEN is set.
 */
const PORT = 3100;
const baseURL = process.env['PLAYWRIGHT_BASE_URL'] ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: { baseURL, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Only self-host the app when we aren't pointed at an external stack.
  webServer: process.env['PLAYWRIGHT_BASE_URL']
    ? undefined
    : {
        command: `next start -p ${PORT}`,
        url: baseURL,
        timeout: 120_000,
        reuseExistingServer: !process.env['CI'],
      },
});
