import { expect, test, type Download, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { closeSettings, goToPage, importChronicle, openChronicle, openSettings, selectWord, showChrome } from './helpers';

const loaded = (page: Page, re: RegExp) =>
  page.evaluate((src) => performance.getEntriesByType('resource').some((e) => new RegExp(src).test(e.name)), re.source);
const PDF_LIB = /\/pdf-[\w-]+\.js$/; // pdf-lib's chunk (pdf.js is "pdfjs-…")
const EXCERPT = /\/(ClipOverlay|ExportSheet|ClipsSheet|layout|image)-[\w-]+\.js$/;

async function bytes(d: Download) {
  return readFile((await d.path())!);
}

async function pdfText(data: Buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useWorkerFetch: false, isEvalSupported: false }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    text += c.items.map((it) => ('str' in it ? it.str : '')).join(' ') + '\n';
  }
  return text;
}

/** Clip from "breakthrough" (bottom of p. 5) to the end of the contest sentence on p. 6. */
async function clipAcrossPages(page: Page) {
  await goToPage(page, 5);
  await selectWord(page, 'breakthrough', 5);
  const clipBtn = page.getByRole('button', { name: 'Clip from selection' });
  await expect(clipBtn).toBeVisible();
  await clipBtn.dispatchEvent('pointerdown');
  const bar = page.getByRole('toolbar', { name: 'Clip passage' });
  await expect(bar.getByTestId('clip-span')).toHaveText('p. 5');
  // Clip Mode always clips in the vertical layout, so p. 6 is right below p. 5
  await page.evaluate(() => {
    const sc = document.querySelector('.pdf-scroller')!;
    const p6 = document.querySelector('.pdf-page[data-page="6"]')!;
    sc.scrollBy(0, p6.getBoundingClientRect().top - sc.getBoundingClientRect().top - 200);
  });
  await page.waitForTimeout(300);
  const target = await page.evaluate(() => {
    const span = [...document.querySelectorAll('.pdf-page[data-page="6"] .textLayer span')].find((s) =>
      s.textContent?.includes('2012'),
    )!;
    return span.getBoundingClientRect().bottom + 4;
  });
  const knob = (await page.getByRole('button', { name: 'Clip end' }).boundingBox())!;
  await page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(knob.x + knob.width / 2, knob.y + ((target - knob.y) * i) / 10);
  await page.mouse.up();
  await expect(bar.getByTestId('clip-span')).toHaveText('pp. 5–6');
  return bar;
}

test('clip across a page break, then export image, PDFs and Markdown', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await importChronicle(page);
  await openChronicle(page);
  expect(await loaded(page, EXCERPT)).toBe(false);
  const bar = await clipAcrossPages(page);
  expect(await loaded(page, PDF_LIB)).toBe(false); // clipping alone never loads pdf-lib

  await bar.getByRole('button', { name: 'Export…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Export pp. 5–6' });

  // ---- image: the empty space between the pages is gone
  const img = sheet.getByRole('img', { name: 'Clip preview' });
  await expect(img).toBeVisible({ timeout: 15_000 });
  const scan = await img.evaluate(async (el: HTMLImageElement) => {
    await el.decode();
    const c = document.createElement('canvas');
    c.width = el.naturalWidth;
    c.height = el.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(el, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let run = 0;
    let longest = 0;
    // skip the outer margins and the footer: look for a gap inside the text
    for (let y = Math.floor(c.height * 0.1); y < c.height * 0.7; y++) {
      let ink = false;
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (px[i] < 200) {
          ink = true;
          break;
        }
      }
      run = ink ? 0 : run + 1;
      longest = Math.max(longest, run);
    }
    return { w: c.width, h: c.height, longest };
  });
  expect(scan.w).toBeGreaterThan(600);
  // a page break left in would be ~1000 px of blank paper at this scale; paragraph gaps are < 100
  expect(scan.longest).toBeLessThan(110);
  let dl = page.waitForEvent('download');
  await sheet.getByRole('link', { name: 'Download' }).click();
  let file = await dl;
  expect(file.suggestedFilename()).toMatch(/\.png$/);
  expect((await bytes(file)).subarray(1, 4).toString()).toBe('PNG');

  // ---- cropped PDF: two pages, each cut down to the clip, still searchable
  await sheet.getByRole('radio', { name: 'PDF' }).click();
  await expect(sheet.getByText(/\.pdf$/)).toBeVisible({ timeout: 15_000 });
  expect(await loaded(page, PDF_LIB)).toBe(true);
  dl = page.waitForEvent('download');
  await sheet.getByRole('link', { name: 'Download' }).click();
  file = await dl;
  const cropped = await bytes(file);
  expect(cropped.subarray(0, 5).toString()).toBe('%PDF-');
  const pdf = await PDFDocument.load(cropped);
  expect(pdf.getPageCount()).toBe(2);
  for (const p of pdf.getPages()) expect(p.getCropBox().height).toBeLessThan(595 * 0.6);
  const text = await pdfText(cropped);
  expect(text).toContain('breakthrough');
  expect(text).toContain('2012');

  // ---- clean text PDF: one continuous page, no page break
  await sheet.getByRole('radio', { name: /Clean text/ }).click();
  await expect(sheet.getByText(/\.pdf$/)).toBeVisible({ timeout: 15_000 });
  dl = page.waitForEvent('download');
  await sheet.getByRole('link', { name: 'Download' }).click();
  const clean = await bytes(await dl);
  expect((await PDFDocument.load(clean)).getPageCount()).toBe(1);
  expect(await pdfText(clean)).toMatch(/demand\s+that followed/);

  // ---- Markdown: de-hyphenated across the page break, cited, no running header or page number
  await sheet.getByRole('radio', { name: 'Markdown' }).click();
  const md = sheet.getByTestId('markdown-preview');
  await expect(md).toContainText('the demand that followed');
  await sheet.getByRole('button', { name: 'Copy as Markdown' }).click();
  await expect(sheet.getByRole('button', { name: 'Copied' })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/^> /);
  expect(copied).toContain('the demand that followed reshaped the company');
  expect(copied).not.toContain('de- mand');
  expect(copied).not.toContain('THE CHIP CHRONICLE');
  expect(copied).toContain('> — *The Chip Chronicle*, OwlReader Tests, pp. 5–6');
});

test('Markdown keeps headings and numbered lists', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  await goToPage(page, 5);
  await showChrome(page);
  await page.getByRole('button', { name: 'Clip passage' }).click();
  const bar = page.getByRole('toolbar', { name: 'Clip passage' });
  await expect(bar.getByTestId('clip-span')).toHaveText(/p\. 5/);
  // pull the start handle up to the top of page 5
  await page.evaluate(() => {
    const sc = document.querySelector('.pdf-scroller')!;
    const p5 = document.querySelector('.pdf-page[data-page="5"]')!;
    sc.scrollBy(0, p5.getBoundingClientRect().top - sc.getBoundingClientRect().top - 120);
  });
  await page.waitForTimeout(300);
  const top = await page.evaluate(() => document.querySelector('.pdf-page[data-page="5"]')!.getBoundingClientRect().top + 30);
  const knob = (await page.getByRole('button', { name: 'Clip start' }).boundingBox())!;
  await page.mouse.move(knob.x + 22, knob.y + 22);
  await page.mouse.down();
  await page.mouse.move(knob.x + 22, top, { steps: 8 });
  await page.mouse.up();
  await bar.getByRole('button', { name: 'Export…' }).click();
  const sheet = page.getByRole('dialog', { name: /^Export / });
  await sheet.getByRole('radio', { name: 'Markdown' }).click();
  const md = sheet.getByTestId('markdown-preview');
  await expect(md).toContainText('> ### Chapter Three: CUDA');
  await expect(md).toContainText('> 1. Write the kernel in a C dialect.');
  await expect(md).toContainText('> 3. Launch thousands of threads at once.');
});

test('save a clip, find it under Clips, jump to it, delete it; deleting the book deletes its clips', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  const bar = await clipAcrossPages(page);
  await bar.getByRole('button', { name: 'Save' }).click();
  await expect(bar.getByRole('button', { name: 'Saved' })).toBeVisible();
  await bar.getByRole('button', { name: 'Cancel' }).click();
  await expect(bar).toBeHidden();
  await goToPage(page, 10);

  const panel = await openSettings(page);
  await panel.getByRole('button', { name: 'Clips' }).click();
  const clips = page.getByRole('dialog', { name: 'Clips' });
  await expect(clips).toContainText('pp. 5–6');
  await expect(clips).toContainText('breakthrough');
  await clips.getByRole('button', { name: /^Go to clip/ }).click();
  await expect(clips).toBeHidden();
  await expect.poll(async () => Number(/Page (\d+) of/.exec((await page.locator('footer').textContent()) ?? '')?.[1])).toBe(5);

  // save a second one, delete the first from the list
  const bar2 = await clipAcrossPages(page);
  await bar2.getByRole('button', { name: 'Save' }).click();
  await expect(bar2.getByRole('button', { name: 'Saved' })).toBeVisible();
  await bar2.getByRole('button', { name: 'Cancel' }).click();
  const panel2 = await openSettings(page);
  await panel2.getByRole('button', { name: 'Clips' }).click();
  await expect(clips.getByRole('listitem')).toHaveCount(2);
  await clips
    .getByRole('button', { name: /^Delete clip/ })
    .first()
    .click();
  await expect(clips.getByRole('listitem')).toHaveCount(1);
  await page.keyboard.press('Escape');

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
          const q = r.result.transaction('clips').objectStore('clips').count();
          q.onsuccess = () => res(q.result);
        };
      }),
  );
  expect(left).toBe(0);
});

test('Clip Mode uses the vertical layout without changing the Pages setting', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  await expect(page.locator('.pdf-scroller')).toHaveClass(/pdf-paged/);
  await showChrome(page);
  await page.getByRole('button', { name: 'Clip passage' }).click();
  await expect(page.locator('.pdf-scroller')).toHaveClass(/pdf-scrolled/);
  await expect(page.getByRole('button', { name: 'Clip start' })).toBeVisible();
  await page.getByRole('toolbar', { name: 'Clip passage' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.pdf-scroller')).toHaveClass(/pdf-paged/);
  const panel = await openSettings(page);
  await expect(panel.getByRole('radio', { name: 'Pages' })).toHaveAttribute('aria-checked', 'true');
  await closeSettings(page);
});
