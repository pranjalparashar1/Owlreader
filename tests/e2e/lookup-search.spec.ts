import { expect, test } from '@playwright/test';
import { goToPage, importChronicle, mockWikipedia, openChronicle, selectWord, tapPill } from './helpers';

test.beforeEach(async ({ page }) => {
  await mockWikipedia(page);
});

test('search bar: clear button and typed search', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);

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

test('a term only covered inside a broader article shows that section, searched without the book context', async ({ page }) => {
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
  expect(mock.requests.some((u) => /srsearch=Bumpgate&/.test(u) && u.includes('srprop=snippet|sectiontitle'))).toBe(true);
  expect(mock.requests.some((u) => u.includes('srsearch=Bumpgate Nvidia'))).toBe(false);
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

test('disambiguation pages are read and ranked by the names on the page, not searched with the book title', async ({ page }) => {
  const mock = await mockWikipedia(page);
  await importChronicle(page);
  // a list cached by 1.7 (built from a search poisoned by the book title) must not be shown again
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('owlreader');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('lookupCache', 'readwrite');
          tx.objectStore('lookupCache').put({
            key: 'bangalore',
            query: 'Bangalore',
            title: 'Bangalore',
            extract: '',
            type: 'disambiguation',
            candidates: [{ title: 'Ray Epps', snippet: 'street gatherings' }],
            cachedAt: Date.now(),
          });
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
        };
      }),
  );
  await openChronicle(page);
  await goToPage(page, 7);
  await selectWord(page, 'Bangalore', 7);
  const drawer = await tapPill(page, 'Bangalore');
  const list = drawer.getByRole('listitem');
  // "Tel Aviv", next to the word on the page, is in the Karnataka article's intro
  await expect(list.first()).toContainText('Bangalore, Karnataka');
  await expect(list.first()).toContainText('Capital of Karnataka, India');
  await expect(list).toHaveCount(4);
  await expect(drawer).not.toContainText('Ray Epps');
  for (const gone of ['Bangalore (disambiguation)', 'Bangalore Road', 'Bangalore torpedo'])
    await expect(drawer.getByRole('button', { name: new RegExp(gone.replace(/[()]/g, '\\$&')) })).toHaveCount(0);
  expect(mock.requests.some((u) => u.includes('generator=links') && u.includes('titles=Bangalore'))).toBe(true);
  expect(mock.requests.some((u) => u.includes('srsearch=Bangalore'))).toBe(false);
  await list.first().getByRole('button').click();
  await expect(drawer.getByRole('button', { name: 'Back to results' })).toBeVisible();
});
