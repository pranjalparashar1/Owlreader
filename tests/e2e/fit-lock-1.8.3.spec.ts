import { expect, test, type Page } from '@playwright/test';
import { closeSettings, importChronicle, openChronicle, openSettings } from './helpers';

/**
 * 1.8.3: at fit-text zoom the page is locked to the reading axis. The margins hang off screen
 * inside a box exactly as wide as the screen (overflow: clip), so there is no sideways scroll
 * range at all: iOS lets a finger pan an overflow-x: hidden box, which is what made 1.8.2 wobble.
 * Zoomed past fit, the page pans freely again. iOS rubber-banding itself needs a real iPhone.
 */

/** Sideways scroll range of the live page's container, and where its text sits on screen. */
async function probe(page: Page, paged: boolean) {
  return page.evaluate((paged) => {
    const sc = document.querySelector<HTMLElement>('.pdf-scroller')!;
    const box = paged ? document.querySelector<HTMLElement>('.pdf-slot.is-live')! : sc;
    const p = box.querySelector<HTMLElement>('.pdf-page')!;
    const spans = [...p.querySelectorAll<HTMLElement>('.textLayer span')].map((s) => s.getBoundingClientRect());
    box.scrollLeft = 300; // what a sideways pan would do
    const pannedTo = box.scrollLeft;
    box.scrollLeft = 0;
    return {
      vw: innerWidth,
      range: box.scrollWidth - box.clientWidth,
      pannedTo,
      pageW: p.getBoundingClientRect().width,
      left: Math.min(...spans.map((r) => r.left)),
      right: Math.max(...spans.map((r) => r.right)),
      touchAction: getComputedStyle(sc).touchAction,
    };
  }, paged);
}

async function waitForText(page: Page) {
  await expect(page.locator('.pdf-page .textLayer span').first()).toBeAttached();
}

test('Pages: at fit the page has no sideways scroll range, text stays centred', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  await waitForText(page);
  const s = await probe(page, true);
  expect(s.pageW).toBeGreaterThan(s.vw * 1.1); // margins really are off screen
  expect(s.range).toBe(0);
  expect(s.pannedTo).toBe(0);
  expect(s.left).toBeGreaterThan(0);
  expect(s.right).toBeLessThan(s.vw);
  expect(Math.abs(s.left - (s.vw - s.right))).toBeLessThan(20); // centred on the book's text column (union of pages)
});

test('Scroll: at fit the column only moves vertically', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  const panel = await openSettings(page);
  await panel.getByRole('radio', { name: 'Scroll' }).click();
  await closeSettings(page);
  await waitForText(page);
  const s = await probe(page, false);
  expect(s.pageW).toBeGreaterThan(s.vw * 1.1);
  expect(s.range).toBe(0);
  expect(s.pannedTo).toBe(0);
  expect(s.touchAction).toBe('pan-y');
  expect(s.left).toBeGreaterThan(0);
  expect(s.right).toBeLessThan(s.vw);
  expect(Math.abs(s.left - (s.vw - s.right))).toBeLessThan(20);
  // vertical reading still scrolls
  await page.locator('.pdf-scroller').evaluate((el) => el.scrollBy(0, 400));
  expect(await page.locator('.pdf-scroller').evaluate((el) => el.scrollTop)).toBeGreaterThan(300);
});

test('zoomed past fit, the page pans sideways again', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  const panel = await openSettings(page);
  await panel.getByRole('button', { name: 'Zoom in' }).click();
  await closeSettings(page);
  await waitForText(page);
  const s = await probe(page, true);
  expect(s.range).toBeGreaterThan(50);
  expect(s.pannedTo).toBeGreaterThan(50);
});
