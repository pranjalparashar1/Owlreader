import { expect, test } from '@playwright/test';
import { importAtlas, mockWikipedia, openAtlas, openSettings, selectWord, showChrome, tapPill } from './helpers';

test('storage sheet shows usage and clears only the lookup cache', async ({ page }) => {
  await mockWikipedia(page);
  await importAtlas(page);
  await openAtlas(page);
  await selectWord(page, 'Blenheim', 1);
  const drawer = await tapPill(page, 'Blenheim');
  await expect(drawer).toContainText('Blenheim is a village');
  await drawer.getByRole('button', { name: 'Close lookup' }).click();
  await showChrome(page);
  await page.getByRole('button', { name: 'Back to Library' }).click();

  await page.getByRole('button', { name: 'Storage' }).click();
  const sheet = page.getByRole('dialog', { name: 'Storage' });
  await expect(sheet).toContainText(/Space used\s*[\d.]+ (KB|MB|GB)/);
  await expect(sheet.locator('dd').nth(2)).toHaveText('1'); // books
  await expect(sheet.locator('dd').nth(3)).toHaveText('1'); // saved lookups
  await sheet.getByRole('button', { name: 'Clear Lookup Cache' }).click();
  await sheet.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(sheet.locator('dd').nth(3)).toHaveText('0');
  await expect(sheet.locator('dd').nth(2)).toHaveText('1');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open Sample Atlas' })).toBeVisible();
});

test('lookup drawer and settings are modal and trap focus', async ({ page }) => {
  await mockWikipedia(page);
  await importAtlas(page);
  await openAtlas(page);

  const panel = await openSettings(page);
  await expect(panel).toHaveAttribute('aria-modal', 'true');
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab');
    expect(await panel.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');

  await selectWord(page, 'Blenheim', 1);
  const drawer = await tapPill(page, 'Blenheim');
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  await expect(drawer).toContainText('Blenheim is a village');
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
});

test('icon-only controls and pages have accessible names', async ({ page }) => {
  await importAtlas(page);
  await expect(page.getByRole('button', { name: 'Storage' })).toBeVisible();
  await openAtlas(page);
  await showChrome(page);
  for (const name of ['Back to Library', 'Reading settings', 'Fit text', 'Previous page', 'Next page']) {
    await expect(page.getByRole('button', { name })).toBeVisible();
  }
  await expect(page.getByRole('slider', { name: 'Page' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Page 1', exact: true })).toBeAttached();
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });
  test('drawer and bars do not animate', async ({ page }) => {
    await mockWikipedia(page);
    await importAtlas(page);
    await openAtlas(page);
    await selectWord(page, 'Blenheim', 1);
    const drawer = await tapPill(page, 'Blenheim');
    const duration = await drawer.evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(parseFloat(duration)).toBeLessThanOrEqual(0.001);
  });
});
