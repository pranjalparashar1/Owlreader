import { expect, test, type Page } from '@playwright/test';
import {
  closeSettings,
  currentPage,
  goToPage,
  importAtlas,
  importChronicle,
  mockWikipedia,
  openAtlas,
  openChronicle,
  openSettings,
  selectWord,
  showChrome,
  tapPill,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await mockWikipedia(page);
});

const loadedXrayWorker = (page: Page) =>
  page.evaluate(() => performance.getEntriesByType('resource').some((e) => /xrayWorker/.test(e.name)));

async function setXray(page: Page, label: 'Off' | 'This page' | 'Whole book') {
  const panel = await openSettings(page);
  await panel.getByRole('radiogroup', { name: 'X-Ray' }).getByRole('radio', { name: label }).click();
  return panel;
}

test('search bar: clear button, typed search, and the book context is seeded from the PDF', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  const panel = await openSettings(page);
  await expect(panel.getByRole('textbox', { name: 'Book context' })).toHaveValue('Nvidia'); // PDF Subject
  await closeSettings(page);

  await selectWord(page, 'Santa Clara', 1);
  const drawer = await tapPill(page, 'Santa Clara');
  await expect(drawer).toContainText('Santa Clara is a city in California');
  const search = drawer.getByRole('searchbox', { name: 'Search Wikipedia' });
  await drawer.getByRole('button', { name: 'Clear search' }).click();
  await expect(search).toHaveValue('');
  await search.fill('Jensen Huang');
  await search.press('Enter');
  await expect(drawer).toContainText('Taiwanese-American businessman');
});

test('a term only covered inside a broader article shows that section, boosted by the book context', async ({ page }) => {
  const mock = await mockWikipedia(page);
  await importChronicle(page);
  await openChronicle(page);
  await goToPage(page, 3);
  await selectWord(page, 'Bumpgate', 3);
  const drawer = await tapPill(page, 'Bumpgate');
  await expect(drawer).toContainText('No article called “Bumpgate”');
  await expect(drawer.getByRole('heading', { name: 'Nvidia' })).toBeVisible();
  await expect(drawer).toContainText('§ Laptop GPU failures');
  await expect(drawer.locator('mark')).toHaveText('Bumpgate');
  await expect(drawer.getByRole('link', { name: /Read this section on Wikipedia/ })).toHaveAttribute(
    'href',
    /wiki\/Nvidia#Laptop_GPU_failures$/,
  );
  expect(mock.requests.some((u) => u.includes('srsearch=Bumpgate Nvidia') && u.includes('srprop=snippet|sectiontitle'))).toBe(
    true,
  );
  await expect(drawer.getByRole('link', { name: /Search “Bumpgate Nvidia” on Google/ })).toHaveAttribute(
    'href',
    'https://www.google.com/search?q=Bumpgate%20Nvidia',
  );
});

test('context chips refine the search in one tap; not-found cards offer Google', async ({ page }) => {
  const mock = await mockWikipedia(page);
  await importChronicle(page);
  await openChronicle(page);
  await goToPage(page, 3);
  await selectWord(page, 'underfill', 3);
  const drawer = await tapPill(page, 'underfill');
  await expect(drawer).toContainText('No Wikipedia article found');
  await expect(drawer.getByRole('link', { name: /Search “underfill Nvidia” on Google/ })).toBeVisible();

  const chips = drawer.getByRole('group', { name: 'Add context' });
  await expect(chips.getByRole('button', { name: 'Add Nvidia to the search' })).toBeVisible();
  // nearby capitalised terms from the page itself
  await expect(chips.getByRole('button', { name: 'Add TSMC to the search' })).toBeVisible();
  await chips.getByRole('button', { name: 'Add TSMC to the search' }).click();
  await expect(drawer.getByRole('searchbox', { name: 'Search Wikipedia' })).toHaveValue('underfill TSMC');
  await expect.poll(() => mock.requests.some((u) => u.includes('srsearch=underfill TSMC'))).toBe(true);
});

test('X-Ray lists the names and terms on this page, and a tap looks one up', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  expect(await loadedXrayWorker(page)).toBe(false); // nothing loads until X-Ray is used
  await showChrome(page);
  await page.getByRole('button', { name: 'X-Ray this page' }).click();
  const drawer = page.getByRole('dialog', { name: 'Lookup' });
  await expect(drawer).toContainText('On This Page');
  const list = drawer.getByRole('list', { name: 'On this page' });
  for (const name of [/^Jensen Huang, Person/, /^Nvidia, /, /^Santa Clara, /]) {
    await expect(list.getByRole('button', { name })).toBeVisible();
  }
  await expect(list.getByRole('button', { name: /^Chapter/ })).toHaveCount(0);
  await list.getByRole('button', { name: /^Santa Clara, / }).click();
  await expect(drawer).toContainText('Santa Clara is a city in California');
  await drawer.getByRole('button', { name: 'Back to results' }).click();
  await expect(drawer).toContainText('On This Page');
});

test('X-Ray Off hides the button and runs no extraction', async ({ page }) => {
  await importAtlas(page);
  await openAtlas(page);
  await setXray(page, 'Off');
  await closeSettings(page);
  await showChrome(page);
  await expect(page.getByRole('button', { name: 'X-Ray this page' })).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(800);
  expect(await loadedXrayWorker(page)).toBe(false);
  const idx = await page.evaluate(
    () =>
      new Promise<number>((res) => {
        const r = indexedDB.open('owlreader');
        r.onsuccess = () => {
          const q = r.result.transaction('bookIndex').objectStore('bookIndex').count();
          q.onsuccess = () => res(q.result);
        };
      }),
  );
  expect(idx).toBe(0);
});

test('whole-book index: resumable, In This Book cards, jump and return', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  const panel = await setXray(page, 'Whole book');
  await expect(panel.getByTestId('index-progress')).toHaveText('Indexed all 12 pages', { timeout: 20_000 });
  await closeSettings(page);

  await page.reload();
  await expect(page.locator('.textLayer span').first()).toBeAttached();
  const again = await openSettings(page);
  await expect(again.getByRole('radio', { name: 'Whole book' })).toHaveAttribute('aria-checked', 'true');
  await expect(again.getByTestId('index-progress')).toHaveText('Indexed all 12 pages');
  await closeSettings(page);

  await goToPage(page, 4);
  await selectWord(page, 'Bumpgate', 4);
  const drawer = await tapPill(page, 'Bumpgate');
  const card = drawer.getByRole('region', { name: 'In this book' });
  await expect(card).toContainText('First mentioned on p. 3');
  await expect(card).toContainText('later dubbed Bumpgate');
  await expect(card).toContainText('Mentioned on 4 pages');
  await expect(drawer).toContainText('§ Laptop GPU failures'); // Wikipedia still below
  await card.getByRole('button', { name: 'Go to page 7' }).click();
  await expect(drawer).toBeHidden();
  await expect.poll(() => currentPage(page)).toBe(7);
  await page.getByRole('button', { name: 'Return to p. 4' }).click();
  await expect.poll(() => currentPage(page)).toBe(4);
  await expect(page.getByRole('button', { name: /Return to p\./ })).toHaveCount(0);
});

test('deleting a book deletes its X-Ray index', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  const panel = await setXray(page, 'Whole book');
  await expect(panel.getByTestId('index-progress')).toHaveText('Indexed all 12 pages', { timeout: 20_000 });
  await closeSettings(page);
  await showChrome(page);
  await page.getByRole('button', { name: 'Back to Library' }).click();
  await page.getByRole('button', { name: 'Options for The Chip Chronicle' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('The Chip Chronicle')).toHaveCount(0);
  const left = await page.evaluate(
    () =>
      new Promise<number>((res) => {
        const r = indexedDB.open('owlreader');
        r.onsuccess = () => {
          const q = r.result.transaction('bookIndex').objectStore('bookIndex').count();
          q.onsuccess = () => res(q.result);
        };
      }),
  );
  expect(left).toBe(0);
});
