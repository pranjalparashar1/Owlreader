import { expect, test, type Page } from '@playwright/test';
import { closeSettings, currentPage, importAtlas, openAtlas, openSettings, showChrome } from './helpers';

/** Page under the reading line and how far into it (0..1), measured from the DOM. */
const position = (page: Page) =>
  page.evaluate(() => {
    const sc = document.querySelector('.pdf-scroller')!;
    const r = sc.getBoundingClientRect();
    const probe = r.top + sc.clientHeight * 0.3;
    const el = [...document.querySelectorAll<HTMLElement>('.pdf-page')].find((p) => {
      const b = p.getBoundingClientRect();
      return b.top <= probe && b.bottom + 10 > probe;
    })!;
    const b = el.getBoundingClientRect();
    return { page: Number(el.dataset.page), frac: Math.round(((r.top - b.top) / b.height) * 100) / 100 };
  });

async function goTo(page: Page, n: number) {
  await showChrome(page);
  await page.locator('input.scrubber').fill(String(n));
  await page.locator('input.scrubber').dispatchEvent('pointerup');
  await expect.poll(() => currentPage(page)).toBe(n);
}

test('Pages ↔ Scroll and rotation keep the reading position', async ({ page }) => {
  await importAtlas(page);
  await openAtlas(page);
  await goTo(page, 40);

  const panel = await openSettings(page);
  await panel.getByRole('radio', { name: 'Scroll' }).click();
  await closeSettings(page);
  await page.evaluate(() => document.querySelector('.pdf-scroller')!.scrollBy(0, 200));
  await page.waitForTimeout(500);
  const before = await position(page);
  expect(before.page).toBe(40);

  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(700);
  expect((await position(page)).page).toBe(40);
  await page.setViewportSize({ width: 390, height: 664 });
  await page.waitForTimeout(700);
  const back = await position(page);
  expect(back.page).toBe(40);
  expect(Math.abs(back.frac - before.frac)).toBeLessThan(0.03);

  const panel2 = await openSettings(page);
  await panel2.getByRole('radio', { name: 'Pages' }).click();
  await expect.poll(() => currentPage(page)).toBe(40);
  await panel2.getByRole('radio', { name: 'Scroll' }).click();
  await closeSettings(page);
  await page.waitForTimeout(500);
  expect((await position(page)).page).toBe(40);
});

test('Scroll mode keeps a constant number of page boxes', async ({ page }) => {
  await importAtlas(page);
  await openAtlas(page);
  const panel = await openSettings(page);
  await panel.getByRole('radio', { name: 'Scroll' }).click();
  await closeSettings(page);
  await goTo(page, 250);
  expect(await page.locator('.pdf-page').count()).toBeLessThanOrEqual(22);
});

test('zoom shows a live percentage and resets to fit text', async ({ page }) => {
  await importAtlas(page);
  await openAtlas(page);
  const panel = await openSettings(page);
  const value = panel.getByRole('button', { name: /Fit text to screen/ });
  await expect(value).toHaveText(/^\d+%$/);
  const fit = parseInt((await value.textContent()) ?? '0');
  await panel.getByRole('button', { name: 'Zoom in' }).click();
  await expect(value).toHaveText(`${Math.round(fit * 1.25)}%`);
  await value.click();
  await expect(value).toHaveText(`${fit}%`);
});

test('dark and sepia are baked into the page, not a CSS filter', async ({ page }) => {
  await importAtlas(page);
  await openAtlas(page);
  const panel = await openSettings(page);
  await panel.getByRole('radio', { name: 'Dark' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('.pdf-page[data-page="1"] canvas');
        if (!c) return null;
        const px = c.getContext('2d')!.getImageData(Math.floor(c.width * 0.9), Math.floor(c.height * 0.9), 1, 1).data;
        return { filter: getComputedStyle(c).filter, r: px[0] };
      }),
    )
    .toEqual({ filter: 'none', r: 31 });
});
