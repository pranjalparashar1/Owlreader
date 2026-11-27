import { expect, test, type Page } from '@playwright/test';
import {
  closeSettings,
  importAtlas,
  mockWikipedia,
  openAtlas,
  openSettings,
  selectionText,
  selectWord,
  tapPill,
} from './helpers';

async function setMode(page: Page, label: 'Wiki' | 'Safari' | 'Both') {
  const panel = await openSettings(page);
  await panel.getByRole('radiogroup', { name: 'Look up with' }).getByRole('radio', { name: label }).click();
  await closeSettings(page);
}

test.beforeEach(async ({ page }) => {
  await mockWikipedia(page);
});

test('wiki mode: pill opens the drawer and clears the selection', async ({ page }) => {
  await importAtlas(page);
  await openAtlas(page);
  await selectWord(page, 'Blenheim', 1);
  const drawer = await tapPill(page, 'Blenheim');
  await expect(drawer).toContainText('Blenheim is a village in Bavaria');
  expect(await selectionText(page)).toBe('');
});

test('safari mode: no pill and the selection is left alone; the choice persists', async ({ page }) => {
  await importAtlas(page);
  await openAtlas(page);
  await setMode(page, 'Safari');
  await selectWord(page, 'Blenheim', 1);
  await page.waitForTimeout(600);
  await expect(page.getByRole('button', { name: /^Look up / })).toHaveCount(0);
  expect(await selectionText(page)).toBe('Blenheim');

  await page.reload();
  await expect(page.locator('.textLayer span').first()).toBeAttached();
  const panel = await openSettings(page);
  await expect(panel.getByRole('radio', { name: 'Safari' })).toHaveAttribute('aria-checked', 'true');
});

test('both mode: pill and native selection coexist; selection returns after the drawer', async ({ page }) => {
  await importAtlas(page);
  await openAtlas(page);
  await setMode(page, 'Both');
  await selectWord(page, 'Blenheim', 1);
  const drawer = await tapPill(page, 'Blenheim');
  await expect(drawer).toContainText('Blenheim is a village');
  await drawer.getByRole('button', { name: 'Close lookup' }).click();
  await expect.poll(() => selectionText(page)).toBe('Blenheim');
});

test('disambiguation: tapping a candidate opens that article', async ({ page }) => {
  await importAtlas(page);
  await openAtlas(page);
  await selectWord(page, 'Mercury', 1);
  const drawer = await tapPill(page, 'Mercury');
  await expect(drawer).toContainText('could mean several things');
  await drawer.getByRole('button', { name: /Mercury \(planet\)/ }).click();
  await expect(drawer).toContainText('Mercury is the first planet from the Sun');
  await drawer.getByRole('button', { name: 'Back to results' }).click();
  await expect(drawer).toContainText('could mean several things');
});

test('offline: a cached lookup still opens; refresh fetches a new copy', async ({ page }) => {
  const mock = await mockWikipedia(page);
  await importAtlas(page);
  await openAtlas(page);
  await selectWord(page, 'Blenheim', 1);
  let drawer = await tapPill(page, 'Blenheim');
  await expect(drawer).toContainText('(v1)');
  await drawer.getByRole('button', { name: 'Close lookup' }).click();

  mock.mode = 'offline';
  await selectWord(page, 'Blenheim', 1);
  drawer = await tapPill(page, 'Blenheim');
  await expect(drawer).toContainText('(v1)');
  await expect(drawer).toContainText('Saved offline');

  mock.mode = 'ok';
  mock.version = 'v2';
  await drawer.getByRole('button', { name: 'Expand lookup' }).click();
  await drawer.getByRole('button', { name: 'Refresh from Wikipedia' }).click();
  await expect(drawer).toContainText('(v2)');
});

test('a 503 from Wikipedia shows Retry, which recovers', async ({ page }) => {
  const mock = await mockWikipedia(page);
  mock.mode = '503';
  await importAtlas(page);
  await openAtlas(page);
  await selectWord(page, 'Blenheim', 1);
  const drawer = await tapPill(page, 'Blenheim');
  await expect(drawer).toContainText("Wikipedia isn't responding");
  await expect(drawer).not.toContainText('No Wikipedia article found');
  mock.mode = 'ok';
  await drawer.getByRole('button', { name: 'Retry' }).click();
  await expect(drawer).toContainText('Blenheim is a village');
});
