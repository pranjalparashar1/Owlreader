import { expect, test } from '@playwright/test';
import { ATLAS_PAGES, currentPage, importAtlas, openAtlas, showChrome } from './helpers';

test('imports a PDF, reopens it and remembers the page', async ({ page }) => {
  await importAtlas(page);
  await expect(page.getByText('Not started')).toBeVisible();
  await openAtlas(page);
  await expect(page.locator('footer')).toContainText(`Page 1 of ${ATLAS_PAGES}`);

  // turn pages one at a time, as a reader would
  for (let n = 2; n <= 5; n++) {
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => currentPage(page)).toBe(n);
  }
  await page.waitForTimeout(800); // progress is saved after a short debounce

  await showChrome(page);
  await page.getByRole('button', { name: 'Back to Library' }).click();
  await expect(page.getByText(/% read/)).toBeVisible();

  await page.reload();
  await openAtlas(page);
  await expect.poll(() => currentPage(page)).toBe(5);
});

test('rejects files that are not PDFs', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('input[type=file]').first()).toHaveAttribute('accept', '.pdf,application/pdf');
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.getByRole('alert')).toContainText("isn't a PDF");
});

test('books from older versions in other formats can be deleted, never opened', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res) => {
      // the app may already have created (and upgraded) the database: open whatever version is there
      const r = indexedDB.open('owlreader');
      r.onupgradeneeded = () => {
        r.result.createObjectStore('books', { keyPath: 'id' });
        r.result.createObjectStore('files', { keyPath: 'bookId' });
        r.result.createObjectStore('lookupCache', { keyPath: 'key' });
      };
      r.onsuccess = () => res(r.result);
    });
    const tx = db.transaction(['books', 'files'], 'readwrite');
    const now = Date.now();
    tx.objectStore('books').put({
      id: 'legacy',
      title: 'Old Novel',
      format: 'epub',
      fileSize: 2048,
      addedAt: now,
      lastOpenedAt: now,
      progress: { percentage: 40 },
    });
    tx.objectStore('files').put({ bookId: 'legacy', data: new ArrayBuffer(8), name: 'old', type: '' });
    await new Promise((r) => (tx.oncomplete = r));
    db.close();
  });
  await page.reload();
  await expect(page.getByText('Unsupported · tap to delete')).toBeVisible();
  await page.getByRole('button', { name: /^Old Novel, unsupported format/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('opens PDFs only');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Old Novel')).toHaveCount(0);
});
