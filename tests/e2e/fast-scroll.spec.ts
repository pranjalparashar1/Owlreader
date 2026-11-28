import { expect, test, type Page } from '@playwright/test';
import { closeSettings, currentPage, importAtlas, openAtlas, openSettings } from './helpers';

/**
 * 1.8.1: a fast fling must never show a column of blank pages. Every page box on screen has
 * either its canvas or its preview (a small JPEG painted as the box background), the
 * mounted boxes follow the fling, and the queue paints the page you land on first.
 * Chromium emulation only: iOS momentum and compositor timing still need a real iPhone.
 */

async function scrollMode(page: Page) {
  const panel = await openSettings(page);
  await panel.getByRole('radio', { name: 'Scroll' }).click();
  await closeSettings(page);
}

/** Share of the viewport covered by page boxes that show nothing (no canvas, no preview). */
const blankShare = () => {
  const sc = document.querySelector('.pdf-scroller')!;
  const sr = sc.getBoundingClientRect();
  let blank = 0;
  // spacers stand in for unmounted pages: anything they cover on screen is blank too
  for (const el of document.querySelectorAll<HTMLElement>('.pdf-page, .pdf-spacer')) {
    const r = el.getBoundingClientRect();
    const h = Math.min(r.bottom, sr.bottom) - Math.max(r.top, sr.top);
    if (h <= 0) continue;
    const shows =
      el.classList.contains('pdf-page') && (el.querySelector('.pdf-canvas') || el.style.backgroundImage.includes('url'));
    if (!shows) blank += h;
  }
  return blank / sr.height;
};

/** An iOS-like fling: starts at `v0` px/s and decays to a stop over about 1.5 s. */
const fling = (v0: number) =>
  new Promise<{ worst: number; maxBoxes: number }>((resolve) => {
    const sc = document.querySelector<HTMLElement>('.pdf-scroller')!;
    const share = (window as unknown as { __blank: () => number }).__blank;
    let v = v0;
    let last = performance.now();
    let worst = 0;
    let maxBoxes = 0;
    let frames = 0;
    const step = (t: number) => {
      const dt = (t - last) / 1000;
      last = t;
      sc.scrollTop += v * dt;
      v *= Math.pow(0.12, dt);
      // skip the first frames: the mounted window catches up on the next frame by design
      if (++frames > 2) worst = Math.max(worst, share());
      maxBoxes = Math.max(maxBoxes, document.querySelectorAll('.pdf-page').length);
      if (v > 60) requestAnimationFrame(step);
      else resolve({ worst, maxBoxes });
    };
    requestAnimationFrame(step);
  });

test('a fast fling in Scroll mode shows previews, never blank pages', async ({ page }) => {
  await importAtlas(page);
  await openAtlas(page);
  await scrollMode(page);
  // previews prefetch while the reader is still (every mounted box has one, then further ahead)
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('.pdf-page:not([style*="blob:"])').length), { timeout: 15_000 })
    .toBe(0);
  await page.waitForTimeout(2500);
  await page.evaluate(`window.__blank = ${blankShare.toString()}`);
  const { worst, maxBoxes } = await page.evaluate(fling, 12_000);
  expect(worst).toBeLessThan(0.15);
  expect(maxBoxes).toBeLessThanOrEqual(24);
  await expect.poll(() => currentPage(page)).toBeGreaterThan(10);
  // and the page it lands on gets its sharp canvas
  const landed = await currentPage(page);
  await expect(page.locator(`.pdf-page[data-page="${landed}"] .pdf-canvas`)).toBeAttached();
});

test('a jump in Pages mode lands on a preview at once', async ({ page }) => {
  await importAtlas(page);
  await openAtlas(page);
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('.pdf-page[style*="blob:"]').length), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(15);
  const shown = await page.evaluate(() => {
    const sc = document.querySelector<HTMLElement>('.pdf-scroller')!;
    sc.scrollLeft = sc.clientWidth * 11; // page 12, no time to render
    const box = document.querySelector<HTMLElement>('.pdf-page[data-page="12"]')!;
    return { canvas: !!box.querySelector('.pdf-canvas'), preview: box.style.backgroundImage.includes('blob:') };
  });
  expect(shown).toEqual({ canvas: false, preview: true });
  await expect.poll(() => currentPage(page)).toBe(12);
  await expect(page.locator('.pdf-page[data-page="12"] .pdf-canvas')).toBeAttached();
});

test('previews follow the theme', async ({ page }) => {
  await importAtlas(page);
  await openAtlas(page);
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('.pdf-page[style*="blob:"]').length), { timeout: 15_000 })
    .toBeGreaterThan(5);
  const panel = await openSettings(page);
  await panel.getByRole('radio', { name: 'Dark' }).click();
  await closeSettings(page);
  // re-made in the dark theme: the preview of a far page is a dark image
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const box = document.querySelector<HTMLElement>('.pdf-page[data-page="14"]');
          const m = box && /url\("?(blob:[^")]+)/.exec(box.style.backgroundImage);
          if (!m) return -1;
          const img = new Image();
          img.src = m[1];
          await img.decode();
          const c = document.createElement('canvas');
          c.width = 8;
          c.height = 8;
          const ctx = c.getContext('2d')!;
          ctx.drawImage(img, 0, 0, 8, 8);
          const d = ctx.getImageData(0, 0, 8, 8).data;
          let sum = 0;
          for (let i = 0; i < d.length; i += 4) sum += d[i];
          return sum / 64;
        }),
      { timeout: 15_000 },
    )
    .toBeLessThan(90);
});
