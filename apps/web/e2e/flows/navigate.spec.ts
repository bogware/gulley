import { expect, test } from '@playwright/test';

/**
 * Full navigation flow against a SEEDED stack. Skipped unless E2E_ADMIN_TOKEN is set
 * (and NEXT_PUBLIC_CONTROL_API_URL / PLAYWRIGHT_BASE_URL point at a running control-api).
 * Signs in with the token, then visits every console route and asserts its header renders
 * — a fast smoke that the whole IA is wired and every page mounts without a crash.
 */
const TOKEN = process.env['E2E_ADMIN_TOKEN'];

test.describe('authenticated console navigation', () => {
  test.skip(!TOKEN, 'set E2E_ADMIN_TOKEN + a seeded control-api to run the full flows');

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder('Bearer token').fill(TOKEN!);
    await page.getByRole('button', { name: /Connect with token/i }).click();
    await expect(page.getByText('Overview')).toBeVisible({ timeout: 15_000 });
  });

  const ROUTES: Array<[string, RegExp]> = [
    ['/', /Overview/],
    ['/logs', /Request logs/],
    ['/analytics', /Analytics/],
    ['/observability', /Observability/],
    ['/compliance', /Compliance & WORM/],
    ['/guardrails', /Guardrails/],
    ['/rollouts', /Eval rollouts/],
    ['/finops', /FinOps/],
    ['/budgets', /Budgets/],
    ['/rate-limits', /Rate limits/],
    ['/identity', /Identity/],
    ['/keys', /Virtual keys/],
    ['/config', /Config console/],
    ['/routes', /Routes & aliases/],
    ['/providers', /Providers/],
    ['/prompts', /Prompts/],
    ['/orgs', /Orgs & workspaces/],
    ['/settings', /Settings & status/],
  ];

  for (const [path, heading] of ROUTES) {
    test(`renders ${path}`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
      // No client-side crash: the sidebar wordmark stays mounted.
      await expect(page.getByText('Gulley').first()).toBeVisible();
    });
  }
});
