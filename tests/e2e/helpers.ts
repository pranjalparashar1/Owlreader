import { expect, type Page, type Route } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ATLAS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'atlas.pdf');
export const ATLAS_PAGES = 300;

/** Mutable Wikipedia mock: tests flip `mode` / `version` between steps. */
export interface WikiMock {
  mode: 'ok' | '503' | 'offline' | 'hang';
  version: string;
  requests: string[];
}

const json = (route: Route, body: unknown) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });

const ARTICLES: Record<string, { title: string; extract: string; coordinates?: { lat: number; lon: number } }> = {
  Blenheim: { title: 'Blenheim', extract: 'Blenheim is a village in Bavaria, Germany.', coordinates: { lat: 48.63, lon: 10.6 } },
  'Mercury (planet)': { title: 'Mercury (planet)', extract: 'Mercury is the first planet from the Sun.' },
  'Mercury (element)': { title: 'Mercury (element)', extract: 'Mercury is a chemical element.' },
};

/** Routes every Wikipedia/Wikimedia/OSM request: the test environment never hits the network. */
export async function mockWikipedia(page: Page): Promise<WikiMock> {
  const mock: WikiMock = { mode: 'ok', version: 'v1', requests: [] };
  await page.route(/wikipedia\.org/, async (route) => {
    const url = decodeURIComponent(route.request().url());
    mock.requests.push(url);
    if (mock.mode === 'offline') return route.abort('internetdisconnected');
    if (mock.mode === '503') return route.fulfill({ status: 503, body: 'down' });
    if (mock.mode === 'hang') return; // never answers: the app's 8 s timeout must fire
    const summary = /\/page\/summary\/(.+)$/.exec(url);
    if (summary) {
      const title = summary[1].replace(/_/g, ' ');
      if (title === 'Mercury') return json(route, { type: 'disambiguation', title: 'Mercury', extract: '' });
      const a = ARTICLES[title];
      if (!a) return route.fulfill({ status: 404, body: '{}' });
      return json(route, { type: 'standard', ...a, extract: `${a.extract} (${mock.version})` });
    }
    if (url.includes('list=search')) {
      const q = /srsearch=([^&]+)/.exec(url)?.[1] ?? '';
      const hits = q.toLowerCase().startsWith('mercury')
        ? [
            { title: 'Mercury (planet)', snippet: 'The smallest <b>planet</b>' },
            { title: 'Mercury (element)', snippet: 'Chemical element Hg' },
          ]
        : [];
      return json(route, { query: { search: hits } });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });
  await page.route(/upload\.wikimedia\.org|openstreetmap\.org/, (route) => route.abort());
  return mock;
}

export async function importAtlas(page: Page) {
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles(ATLAS);
  await expect(page.getByRole('button', { name: 'Open Sample Atlas' })).toBeVisible();
}

export async function openAtlas(page: Page) {
  await page.getByRole('button', { name: 'Open Sample Atlas' }).click();
  await expect(page.locator('.textLayer span').first()).toBeAttached();
}

/** Page number shown in the bottom bar. */
export async function currentPage(page: Page) {
  const text = (await page.locator('footer').textContent()) ?? '';
  return Number(/Page (\d+) of/.exec(text)?.[1]);
}

/** The reader hides its bars on page turns; a centre tap brings them back. */
export async function showChrome(page: Page) {
  if (await page.locator('footer[aria-hidden="false"]').count()) return;
  await page.evaluate(() => {
    const s = document.querySelector('.pdf-scroller')!;
    const r = s.getBoundingClientRect();
    s.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  });
  await expect(page.locator('footer[aria-hidden="false"]')).toHaveCount(1);
}

export async function openSettings(page: Page) {
  const panel = page.getByRole('dialog', { name: 'Reading settings' });
  if (await panel.isVisible()) return panel;
  await showChrome(page);
  await page.getByRole('button', { name: 'Reading settings' }).click();
  await expect(panel).toBeVisible();
  return panel;
}

export async function closeSettings(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Reading settings' })).toBeHidden();
}

/** Programmatic text selection on the PDF text layer (what a long-press does on iOS). */
export async function selectWord(page: Page, word: string, pageNum?: number) {
  await page.evaluate(
    ([w, n]) => {
      const scope = n ? `.pdf-page[data-page="${n}"] .textLayer span` : '.textLayer span';
      const span = [...document.querySelectorAll(scope)].find((s) => s.textContent?.includes(w as string))!;
      const node = span.firstChild!;
      const i = node.textContent!.indexOf(w as string);
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + (w as string).length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
    },
    [word, pageNum ?? 0],
  );
}

export const selectionText = (page: Page) => page.evaluate(() => getSelection()?.toString() ?? '');

/** Taps the Look up pill (it acts on pointerdown so the selection can't collapse first). */
export async function tapPill(page: Page, word: string) {
  const pill = page.getByRole('button', { name: `Look up ${word}` });
  await expect(pill).toBeVisible();
  await pill.dispatchEvent('pointerdown');
  return page.getByRole('dialog', { name: 'Lookup' });
}

/** Drags the scrubber from its current value to `target`, sampling the preview card on the way. */
export async function dragScrubber(page: Page, target: number, steps = 30) {
  const box = (await page.locator('input.scrubber').boundingBox())!;
  const max = Number(await page.locator('input.scrubber').getAttribute('max'));
  const from = Number(await page.locator('input.scrubber').inputValue());
  const x = (n: number) => box.x + 10 + ((n - 1) / (max - 1)) * (box.width - 20);
  const y = box.y + box.height / 2;
  await page.mouse.move(x(from), y);
  await page.mouse.down();
  const previewed = new Set<string>();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x(from + ((target - from) * i) / steps), y);
    await page.waitForTimeout(20);
    const p = await page.locator('.scrub-thumb').getAttribute('data-page');
    if (p) previewed.add(p);
  }
  return {
    previewed,
    release: async () => {
      await page.mouse.up();
    },
  };
}
