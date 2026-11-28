import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeSettings, importChronicle, openChronicle, openSettings, selectWord, showChrome } from './helpers';

const FIGURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'figures.pdf');

async function openFigures(page: Page) {
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles(FIGURES);
  await page.getByRole('button', { name: 'Open Figure Sampler' }).click();
  await expect(page.locator('.pdf-page[data-page="1"] canvas')).toBeAttached();
}

async function setTheme(page: Page, name: string) {
  const panel = await openSettings(page);
  await panel.getByRole('radio', { name }).click();
  await closeSettings(page);
}

/** RGB at fractions of page n's bitmap (x, y in 0..1 of the page). */
const pixels = (page: Page, n: number, points: Array<[number, number]>) =>
  page.evaluate(
    ({ n, points }) => {
      const c = document.querySelector<HTMLCanvasElement>(`.pdf-page[data-page="${n}"] canvas`);
      if (!c) return null;
      const ctx = c.getContext('2d')!;
      return points.map(([x, y]) => [
        ...ctx.getImageData(Math.floor(c.width * x), Math.floor(c.height * y), 1, 1).data.slice(0, 3),
      ]);
    },
    { n, points },
  );

// A5 is 420×595 pt. Photo at x 30–210, y from top 110–230; chart at x 230–410.
const SKY = [60 / 420, 125 / 595] as [number, number]; // upper sky of the photo: deep blue
const SUN = [(30 + 180 * 0.75) / 420, (110 + 120 * 0.27) / 595] as [number, number]; // red sun
const CHART_BG = [400 / 420, 120 / 595] as [number, number]; // white chart background
const PAGE = [0.95, 0.95] as [number, number];

for (const [theme, bg] of [
  ['Dark', 31],
  ['Black', 0],
] as const) {
  test(`${theme}: photos keep their colours, page and white-background figures go dark`, async ({ page }) => {
    await openFigures(page);
    await setTheme(page, theme);
    await expect.poll(async () => (await pixels(page, 1, [PAGE]))?.[0][0]).toBe(bg);
    const [sky, sun, chartBg] = (await pixels(page, 1, [SKY, SUN, CHART_BG]))!;
    // a negative would turn the deep blue sky light orange/yellow; kept, it stays blue and darkish
    expect(sky[2]).toBeGreaterThan(sky[0] + 60);
    expect(sky[2]).toBeGreaterThan(120);
    expect(sky[0]).toBeLessThan(90); // and dark: inverted lightness would make it pale
    // the sun stays red (a negative would be cyan)
    expect(sun[0]).toBeGreaterThan(150);
    expect(sun[1]).toBeLessThan(80);
    // the chart's white background inverts with the page
    expect(Math.max(...chartBg)).toBeLessThan(60);
    // no CSS filter on the page bitmap (iOS guardrail)
    await expect(page.locator('.pdf-page[data-page="1"] canvas')).toHaveCSS('filter', 'none');
  });
}

test('Dark: a full-page scan inverts like text instead of staying white', async ({ page }) => {
  await openFigures(page);
  await setTheme(page, 'Dark');
  await showChrome(page);
  await page.locator('input.scrubber').fill('2');
  await page.locator('input.scrubber').dispatchEvent('pointerup');
  await expect.poll(async () => (await pixels(page, 2, [[0.02, 0.02]]))?.[0][0] ?? 255).toBeLessThan(60);
});

test('Black theme makes the chrome pure black and is remembered', async ({ page }) => {
  await openFigures(page);
  await setTheme(page, 'Black');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'black');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(0, 0, 0)');
  expect(await page.locator('meta[name="theme-color"]').getAttribute('content')).toBe('#000000');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'black');
});

test('Clip export offers a Black image theme with a pure black background', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  await selectWord(page, 'founded', 1);
  await page.getByRole('button', { name: 'Clip from selection' }).dispatchEvent('pointerdown');
  const sheet = page.getByRole('dialog', { name: /^Export / });
  await sheet.getByRole('radiogroup', { name: 'Image theme' }).getByRole('radio', { name: 'Black' }).click();
  const img = sheet.getByRole('img', { name: 'Clip preview' });
  await expect
    .poll(
      () =>
        img.evaluate(async (el: HTMLImageElement) => {
          await el.decode();
          const c = document.createElement('canvas');
          c.width = el.naturalWidth;
          c.height = el.naturalHeight;
          const ctx = c.getContext('2d')!;
          ctx.drawImage(el, 0, 0);
          return [...ctx.getImageData(2, 2, 1, 1).data.slice(0, 3)];
        }),
      { timeout: 15_000 },
    )
    .toEqual([0, 0, 0]);
});
