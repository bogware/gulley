import { expect, test } from '@playwright/test';

/**
 * Backend-free smoke: the production build boots and the sign-in renders with the Platinum
 * system loaded. `authConfig()` fails with no control-api, so the token gate falls back to
 * the admin-token form — which is exactly what we assert.
 */
test.describe('console shell (no backend)', () => {
  test('renders the Platinum sign-in', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Gulley')).toBeVisible();
    await expect(page.getByText(/Sign in to the console/i)).toBeVisible();
    await expect(page.getByPlaceholder('Bearer token')).toBeVisible();
    // IBM Plex Sans is loaded via next/font — the wordmark should not fall back to a serif.
    const family = await page
      .getByText('Gulley')
      .first()
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(family.toLowerCase()).toContain('plex');
  });

  test('the platinum canvas ground is painted (not white)', async ({ page }) => {
    await page.goto('/');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    // #F5F3EE ≈ rgb(245, 243, 238) — warm platinum, not pure white.
    expect(bg).toMatch(/rgb\(245,\s*243,\s*238\)/);
  });
});
