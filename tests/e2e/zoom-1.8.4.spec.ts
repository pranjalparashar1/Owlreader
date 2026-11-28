import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { closeSettings, importChronicle, openChronicle, openSettings, showChrome } from './helpers';

/**
 * 1.8.4: every book opens at the default zoom (fit text inside the safe area), which is also the
 * furthest out; in landscape the text clears the Dynamic Island; a pinch scales one layer and
 * holds the render queue; X-Ray's IndexedDB store is deleted without touching anything else.
 * Chromium emulation: frame rate on a ProMotion iPhone and the real island need a device.
 */

const waitForText = (page: Page) => expect(page.locator('.pdf-page .textLayer span').first()).toBeAttached();

/** Where the live page's text sits on screen. */
const textSpan = (page: Page) =>
  page.evaluate(() => {
    const p = document.querySelector<HTMLElement>('.pdf-slot.is-live .pdf-page, .pdf-scrolled .pdf-page')!;
    const spans = [...p.querySelectorAll<HTMLElement>('.textLayer span')].map((s) => s.getBoundingClientRect());
    return {
      vw: innerWidth,
      left: Math.min(...spans.map((r) => r.left)),
      right: Math.max(...spans.map((r) => r.right)),
      fontPx: parseFloat(getComputedStyle(p).getPropertyValue('--total-scale-factor')),
    };
  });

/** Two-finger pinch from `d0` to `d1` px apart around the screen centre, at ~120 Hz. */
async function pinch(cdp: CDPSession, page: Page, d0: number, d1: number, steps = 24) {
  const { w, h } = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const cx = w / 2;
  const cy = h / 2;
  const pts = (d: number) => [
    { x: cx - d / 2, y: cy, id: 0 },
    { x: cx + d / 2, y: cy, id: 1 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(d0) });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d0 + ((d1 - d0) * i) / steps) });
    await page.waitForTimeout(8);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const zoomValue = async (page: Page) => {
  const panel = await openSettings(page);
  const text = await panel.getByRole('button', { name: /Default zoom/ }).textContent();
  await closeSettings(page);
  return text;
};

test('reopening a book starts at the default zoom, not the last one', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  await waitForText(page);
  const fit = await textSpan(page);
  const panel = await openSettings(page);
  await panel.getByRole('button', { name: 'Zoom in' }).click();
  await panel.getByRole('button', { name: 'Zoom in' }).click();
  await expect(panel.getByRole('button', { name: /Default zoom/ })).toHaveText('156%');
  await closeSettings(page);
  await page.waitForTimeout(800); // past the progress debounce

  await page.reload();
  await waitForText(page);
  await expect.poll(async () => (await textSpan(page)).fontPx).toBeCloseTo(fit.fontPx, 3);
  expect(await zoomValue(page)).toBe('100%');
});

test('the default zoom is the furthest out: Zoom out is disabled and a pinch out springs back', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  await waitForText(page);
  const before = await textSpan(page);
  const panel = await openSettings(page);
  await expect(panel.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
  await closeSettings(page);

  const cdp = await page.context().newCDPSession(page);
  await pinch(cdp, page, 300, 120);
  // the preview rubber-bands, then springs back on the compositor
  await expect.poll(() => page.locator('.pdf-scroller').evaluate((el) => el.style.transform)).toBe('');
  const after = await textSpan(page);
  expect(after.fontPx).toBeCloseTo(before.fontPx, 3);
  expect(await zoomValue(page)).toBe('100%');
});

test('a pinch zooms in around the fingers, renders nothing mid-gesture, then lays out once', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  await expect(page.locator('.pdf-page[data-page="1"] .pdf-canvas')).toBeAttached();
  await page.waitForTimeout(1200); // let the sharp pass and idle work finish
  const before = await textSpan(page);
  const cdp = await page.context().newCDPSession(page);

  // count canvases created while two fingers are down
  await page.evaluate(() => {
    const w = window as unknown as { __made: number; __pinching: boolean };
    w.__made = 0;
    w.__pinching = false;
    const orig = document.createElement.bind(document);
    document.createElement = ((tag: string, o?: ElementCreationOptions) => {
      if (tag === 'canvas' && w.__pinching) w.__made++;
      return orig(tag, o);
    }) as typeof document.createElement;
    addEventListener('touchstart', (e) => e.touches.length === 2 && (w.__pinching = true), { capture: true });
    addEventListener('touchend', () => (w.__pinching = false), { capture: true });
  });
  await pinch(cdp, page, 150, 300, 40);
  expect(await page.evaluate(() => (window as unknown as { __made: number }).__made)).toBe(0);

  await expect.poll(() => page.locator('.pdf-scroller').evaluate((el) => el.style.transform)).toBe('');
  await expect.poll(async () => (await textSpan(page)).fontPx).toBeGreaterThan(before.fontPx * 1.6);
  const pct = parseInt((await zoomValue(page)) ?? '0');
  expect(pct).toBeGreaterThan(170);
  expect(pct).toBeLessThan(230);
  // zoomed past the default, the page pans sideways again
  const range = await page
    .locator('.pdf-slot.is-live')
    .first()
    .evaluate((el) => el.scrollWidth - el.clientWidth)
    .catch(() => 0);
  expect(range).toBeGreaterThan(50);
});

test.describe('landscape with a Dynamic Island', () => {
  test.use({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });

  test('the text column sits inside the safe area at the default zoom', async ({ page }) => {
    // iOS's landscape insets on an iPhone 14: 47 pt each side, 21 pt for the home indicator
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { left: 47, right: 47, top: 0, bottom: 21 } });
    await importChronicle(page);
    await openChronicle(page);
    await waitForText(page);
    await expect
      .poll(async () => {
        const s = await textSpan(page);
        return s.left > 47 && s.right < s.vw - 47;
      })
      .toBe(true);
    const s = await textSpan(page);
    // and fills it: the column starts 14 px inside the inset (this page's lines are ragged right)
    expect(s.left).toBeGreaterThan(47 + 8);
    expect(s.left).toBeLessThan(47 + 20);

    // Scroll mode too
    const panel = await openSettings(page);
    await panel.getByRole('radio', { name: 'Scroll' }).click();
    await closeSettings(page);
    await waitForText(page);
    const t = await textSpan(page);
    expect(t.left).toBeGreaterThan(47);
    expect(t.right).toBeLessThan(t.vw - 47);
  });
});

test('upgrading deletes the X-Ray store and keeps books, files, lookups and clips', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  await showChrome(page);
  await page.getByRole('button', { name: 'Back to Library' }).click();
  // roll the database back to what 1.8.3 left: v3 with a bookIndex row and a clip
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        {
          const r = indexedDB.open('owlreader');
          r.onsuccess = () => {
            const d = r.result;
            const tx = d.transaction(['books', 'files', 'lookupCache', 'clips'], 'readonly');
            const all: Record<string, unknown[]> = {};
            for (const s of ['books', 'files', 'lookupCache', 'clips'])
              tx.objectStore(s).getAll().onsuccess = (e) => (all[s] = (e.target as IDBRequest).result);
            tx.oncomplete = () => {
              d.close();
              const drop = indexedDB.deleteDatabase('owlreader');
              drop.onsuccess = () => {
                const v3 = indexedDB.open('owlreader', 3);
                v3.onupgradeneeded = () => {
                  const db = v3.result;
                  db.createObjectStore('books', { keyPath: 'id' });
                  db.createObjectStore('files', { keyPath: 'bookId' });
                  db.createObjectStore('lookupCache', { keyPath: 'key' });
                  db.createObjectStore('bookIndex', { keyPath: 'bookId' });
                  db.createObjectStore('clips', { keyPath: 'id' }).createIndex('bookId', 'bookId');
                };
                v3.onsuccess = () => {
                  const db = v3.result;
                  const w = db.transaction(['books', 'files', 'lookupCache', 'bookIndex', 'clips'], 'readwrite');
                  const book = all.books[0] as { id: string };
                  for (const b of all.books) w.objectStore('books').put({ ...(b as object), xrayWholeBook: true });
                  for (const f of all.files) w.objectStore('files').put(f);
                  w.objectStore('lookupCache').put({
                    key: 'nvidia',
                    query: 'Nvidia',
                    title: 'Nvidia',
                    extract: 'x',
                    type: 'standard',
                    cachedAt: Date.now(),
                  });
                  w.objectStore('bookIndex').put({
                    bookId: book.id,
                    indexedPages: 1,
                    totalPages: 12,
                    entities: {},
                    updatedAt: 1,
                  });
                  w.objectStore('clips').put({
                    id: 'c1',
                    bookId: book.id,
                    startPage: 1,
                    startY: 0.1,
                    endPage: 1,
                    endY: 0.3,
                    title: 't',
                    previewText: 'p',
                    createdAt: 1,
                  });
                  w.oncomplete = () => {
                    db.close();
                    resolve();
                  };
                };
              };
              drop.onerror = () => reject(drop.error);
            };
          };
        }
      }),
  );
  await page.reload();
  await expect(page.getByText('The Chip Chronicle')).toBeVisible();
  await openChronicle(page);
  await waitForText(page);
  const after = await page.evaluate(
    () =>
      new Promise<{ version: number; stores: string[]; counts: Record<string, number> }>((resolve) => {
        const r = indexedDB.open('owlreader');
        r.onsuccess = () => {
          const d = r.result;
          const stores = [...d.objectStoreNames];
          const counts: Record<string, number> = {};
          const tx = d.transaction(stores, 'readonly');
          for (const s of stores) tx.objectStore(s).count().onsuccess = (e) => (counts[s] = (e.target as IDBRequest).result);
          tx.oncomplete = () => resolve({ version: d.version, stores, counts });
        };
      }),
  );
  expect(after.version).toBe(4);
  expect(after.stores.sort()).toEqual(['books', 'clips', 'files', 'lookupCache']);
  expect(after.counts).toEqual({ books: 1, clips: 1, files: 1, lookupCache: 1 });
});
