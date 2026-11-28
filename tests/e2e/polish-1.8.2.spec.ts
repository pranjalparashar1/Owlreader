import { expect, test } from '@playwright/test';
import { closeSettings, currentPage, importChronicle, openChronicle, openSettings, showChrome } from './helpers';

/**
 * 1.8.2: fit-text zoom, theme switch in one frame, chapters menu, page-select highlight, and
 * the stripped-down settings. Chromium emulation: the View Transition crossfade, iOS's own
 * selection bar and its blue wash only exist on a real iPhone.
 */

test('opens at fit text: the text column fills the screen, margins clipped', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  const geo = await page.evaluate(() => {
    const slot = document.querySelector<HTMLElement>('.pdf-slot.is-live')!;
    const p = slot.querySelector<HTMLElement>('.pdf-page')!;
    const spans = [...p.querySelectorAll<HTMLElement>('.textLayer span')].map((s) => s.getBoundingClientRect());
    return {
      vw: innerWidth,
      pageW: p.getBoundingClientRect().width,
      left: Math.min(...spans.map((r) => r.left)),
      right: Math.max(...spans.map((r) => r.right)),
      overflowX: getComputedStyle(slot).overflowX,
    };
  });
  expect(geo.pageW).toBeGreaterThan(geo.vw * 1.1); // zoomed past fit width
  expect(geo.left).toBeGreaterThan(0); // no text cut off…
  expect(geo.right).toBeLessThan(geo.vw);
  expect(geo.left).toBeLessThan(40); // …and little margin left over
  expect(geo.vw - geo.right).toBeLessThan(40);
  expect(geo.overflowX).toBe('hidden'); // a sideways swipe turns the page, never pans to a margin
});

test('a theme change swaps the visible page in the same frame as the colours', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  await expect(page.locator('.pdf-page[data-page="1"] .pdf-canvas')).toBeAttached();
  // read the page's corner pixel the instant the theme attribute flips
  await page.evaluate(() => {
    new MutationObserver(() => {
      const c = document.querySelector<HTMLCanvasElement>('.pdf-page[data-page="1"] .pdf-canvas')!;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      (window as unknown as { __px: number }).__px = ctx.getImageData(2, 2, 1, 1).data[0];
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  });
  const panel = await openSettings(page);
  await panel.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => (window as unknown as { __px: number }).__px)).toBeLessThan(60);
});

test('settings: no descriptions, no Book context, no scroll bar', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  const panel = await openSettings(page);
  await expect(panel.getByRole('textbox')).toHaveCount(0);
  await expect(panel.locator('p')).toHaveCount(0);
  expect(await panel.evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe('none');
  await closeSettings(page);
});

test('the title is centred and opens a chapters menu', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  await showChrome(page);
  const title = page.getByRole('button', { name: /Chapters$/ });
  const box = (await title.boundingBox())!;
  const vw = await page.evaluate(() => innerWidth);
  expect(Math.abs(box.x + box.width / 2 - vw / 2)).toBeLessThan(4);
  await title.click();
  const menu = page.getByRole('menu', { name: 'Chapters' });
  await expect(menu.getByRole('menuitem')).toHaveCount(4);
  await expect(menu.getByRole('menuitem', { name: /Chapter One/ })).toHaveAttribute('aria-current', 'true');
  await menu.getByRole('menuitem', { name: /Chapter Three/ }).click();
  await expect(menu).toBeHidden();
  await expect.poll(() => currentPage(page)).toBe(5);
});

test("a long-press that grabs the whole page becomes Owl's highlight, with Clip", async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  await expect(page.locator('.pdf-page[data-page="1"] .textLayer span').first()).toBeAttached();
  // what iOS does on a long-press over a zoomed-out page: finger down, whole page selected, finger up
  await page.evaluate(async () => {
    const layer = document.querySelector('.pdf-page[data-page="1"] .textLayer')!;
    const r = layer.getBoundingClientRect();
    const touch = (type: string) => {
      const t = new Touch({ identifier: 1, target: layer, clientX: r.left + 60, clientY: r.top + 200 });
      layer.dispatchEvent(new TouchEvent(type, { bubbles: true, touches: type === 'touchend' ? [] : [t], changedTouches: [t] }));
    };
    touch('touchstart');
    const range = document.createRange();
    range.selectNodeContents(layer);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    await new Promise((res) => setTimeout(res, 420));
    touch('touchend');
  });
  await expect(page.locator('.pdf-page[data-page="1"] .page-select > div').first()).toBeAttached();
  expect(await page.evaluate(() => getSelection()!.isCollapsed)).toBe(true);
  const clip = page.getByRole('button', { name: 'Clip from selection' });
  await expect(clip).toBeVisible();
  await clip.dispatchEvent('pointerdown');
  await expect(page.getByRole('dialog', { name: /^Export / })).toBeVisible();
  await expect(page.locator('.page-select')).toHaveCount(0);
});
