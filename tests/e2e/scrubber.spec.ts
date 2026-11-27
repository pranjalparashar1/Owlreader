import { expect, test } from '@playwright/test';
import { currentPage, dragScrubber, importAtlas, openAtlas, showChrome } from './helpers';

test('dragging the scrubber shows live previews and lands on the previewed page', async ({ page }) => {
  await importAtlas(page);
  await openAtlas(page);
  await showChrome(page);

  const drag = await dragScrubber(page, 200);
  const card = page.locator('.scrub-preview');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Page 200 of 300');
  await expect(page.locator('.scrub-thumb canvas')).toBeAttached();
  await expect(page.locator('.scrub-thumb')).toHaveAttribute('data-page', '200');
  expect(drag.previewed.size).toBeGreaterThanOrEqual(6);
  // the book stays put while dragging: page 1 is still rendered, page 200 isn't yet
  await expect(page.locator('.pdf-page[data-page="1"] canvas')).toBeAttached();
  await expect(page.locator('.pdf-page[data-page="200"] canvas')).toHaveCount(0);

  await drag.release();
  await expect(card).toBeHidden();
  await expect.poll(() => currentPage(page)).toBe(200);
  await expect(page.locator('.pdf-page[data-page="200"] canvas')).toBeAttached();
});
