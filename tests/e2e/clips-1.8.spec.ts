import { expect, test, type Download, type Locator, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { goToPage, importChronicle, openChronicle, openSettings, showChrome } from './helpers';

// Set DUMP=/some/dir to keep every exported image for a visual check.
const DUMP = process.env.DUMP;

async function bytes(d: Download) {
  return readFile((await d.path())!);
}

/** Selects from the start of `from` to the end of `to` (both on page n), like dragging iOS's handles. */
async function selectSpan(page: Page, n: number, from: string, to: string) {
  await page.evaluate(
    ([n, from, to]) => {
      const spans = [...document.querySelectorAll(`.pdf-page[data-page="${n}"] .textLayer span`)];
      const a = spans.find((s) => s.textContent?.includes(from as string))!;
      const b = spans.find((s) => s.textContent?.includes(to as string))!;
      const r = document.createRange();
      r.setStart(a.firstChild!, a.textContent!.indexOf(from as string));
      r.setEnd(b.firstChild!, b.textContent!.indexOf(to as string) + (to as string).length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
    },
    [n, from, to] as const,
  );
}

/** Clicks the middle of the first text-layer span on page n containing `text` (a tap, in Clip Mode). */
async function tapText(page: Page, n: number, text: string) {
  const span = page.locator(`.pdf-page[data-page="${n}"] .textLayer span`, { hasText: text }).first();
  if (!(await span.count())) {
    // Clip Mode scrolls: bring page n's box into view so its text layer mounts
    await page.evaluate((n) => {
      const sc = document.querySelector('.pdf-scroller')!;
      const boxes = [...document.querySelectorAll<HTMLElement>('.pdf-page[data-page]')];
      const last = boxes[boxes.length - 1];
      const el = document.querySelector(`.pdf-page[data-page="${n}"]`) ?? last;
      sc.scrollBy(0, el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 100);
    }, n);
  }
  await expect(span).toBeAttached();
  await span.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);
  const r = (await span.boundingBox())!;
  await page.mouse.click(r.x + Math.min(r.width / 2, 40), r.y + r.height / 2);
}

/** Decodes a preview image and reports its size, a few pixels and its blank margins. */
const inspect = (img: Locator) =>
  img.evaluate(async (el: HTMLImageElement) => {
    await el.decode();
    const c = document.createElement('canvas');
    c.width = el.naturalWidth;
    c.height = el.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(el, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    const bg = [px[0], px[1], px[2]];
    const differs = (i: number) => Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]) > 90;
    // text block: columns/rows with ink, ignoring the footer (bottom 12%)
    const limit = Math.floor(c.height * 0.88);
    let left = c.width;
    let right = -1;
    let top = -1;
    for (let y = 0; y < limit; y++)
      for (let x = 0; x < c.width; x++)
        if (differs((y * c.width + x) * 4)) {
          if (top < 0) top = y;
          if (x < left) left = x;
          if (x > right) right = x;
        }
    return { w: c.width, h: c.height, bg, left, right: c.width - 1 - right, top };
  });

async function dump(img: Locator, name: string) {
  if (!DUMP) return;
  const data = await img.evaluate(async (el: HTMLImageElement) => {
    const b = await (await fetch(el.src)).blob();
    return [...new Uint8Array(await b.arrayBuffer())];
  });
  await writeFile(`${DUMP}/${name}.png`, Buffer.from(data));
}

test('a long selection offers Clip (even with iOS-only lookup), straight to Export, and Save', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  // iOS-only lookup: Owl shows no Look up pill, but Clip is still offered
  const panel = await openSettings(page);
  await panel.getByRole('radio', { name: 'iOS' }).click();
  await page.keyboard.press('Escape');
  await goToPage(page, 5);
  await selectSpan(page, 5, 'CUDA was launched', 'Launch thousands');
  await expect(page.getByRole('button', { name: /^Look up / })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clip from selection' }).dispatchEvent('pointerdown');
  const sheet = page.getByRole('dialog', { name: 'Export p. 5' });
  await expect(sheet).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Clip passage' })).toHaveCount(0); // no handles step
  await sheet.getByRole('radio', { name: 'Markdown' }).click();
  const md = sheet.getByTestId('markdown-preview');
  await expect(md).toContainText('CUDA was launched in 2006');
  await expect(md).toContainText('3. Launch thousands of threads at once.');
  await expect(md).not.toContainText('Chapter Three');
  await expect(md).not.toContainText('breakthrough');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet.getByRole('button', { name: 'Saved' })).toBeVisible();
  await page.keyboard.press('Escape');
  const p2 = await openSettings(page);
  await p2.getByRole('button', { name: 'Clips' }).click();
  await expect(page.getByRole('dialog', { name: 'Clips' })).toContainText('CUDA was launched');
});

test('tap-to-snap: tapping a heading then a list item clips exactly those paragraphs', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  await goToPage(page, 5);
  await showChrome(page);
  await page.getByRole('button', { name: 'Clip passage' }).click();
  const bar = page.getByRole('toolbar', { name: 'Clip passage' });
  await tapText(page, 5, 'Chapter Three');
  await tapText(page, 5, 'Launch thousands');
  await expect(bar.getByTestId('clip-span')).toHaveText('p. 5');
  await expect(page.locator('footer[aria-hidden="false"]')).toHaveCount(0); // taps don't summon the chrome
  await bar.getByRole('button', { name: 'Export…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Export p. 5' });
  await sheet.getByRole('radio', { name: 'Markdown' }).click();
  const md = sheet.getByTestId('markdown-preview');
  await expect(md).toContainText('> ### Chapter Three: CUDA');
  await expect(md).toContainText('> 3. Launch thousands of threads at once.');
  await expect(md).not.toContainText('breakthrough');
  // a tap inside a longer clip starts over from that paragraph
  await page.keyboard.press('Escape');
  await tapText(page, 5, 'CUDA was launched');
  await bar.getByRole('button', { name: 'Export…' }).click();
  await sheet.getByRole('radio', { name: 'Markdown' }).click();
  await expect(md).toContainText('CUDA was launched');
  await expect(md).not.toContainText('Chapter Three');
  await expect(md).not.toContainText('Launch thousands');
});

test('Original export: even margins despite a gutter rule; dark reader exports true black', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  await goToPage(page, 8);
  await selectSpan(page, 8, 'The data centre', 'by the thousand');
  await page.getByRole('button', { name: 'Clip from selection' }).dispatchEvent('pointerdown');
  const sheet = page.getByRole('dialog', { name: 'Export p. 8' });
  await sheet.getByRole('radio', { name: 'Original' }).click();
  await sheet.getByRole('radiogroup', { name: 'Image theme' }).getByRole('radio', { name: 'Light' }).click();
  const img = sheet.getByRole('img', { name: 'Clip preview' });
  await expect(img).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await inspect(img)).bg).toEqual([255, 255, 255]);
  const m = await inspect(img);
  await dump(img, 'original-light');
  expect(m.w).toBe(1600);
  // the gutter rule at the page's inner edge is left out: left and right margins match
  expect(Math.abs(m.left - m.right)).toBeLessThan(m.w * 0.02);
  expect(Math.abs(m.top - m.left)).toBeLessThan(m.w * 0.03);
  await page.keyboard.press('Escape');

  // a dark-theme reader gets #000 by default, not the page's #1f1f1f
  const panel = await openSettings(page);
  await panel.getByRole('radio', { name: 'Dark' }).click();
  await page.keyboard.press('Escape');
  await selectSpan(page, 8, 'The data centre', 'by the thousand');
  await page.getByRole('button', { name: 'Clip from selection' }).dispatchEvent('pointerdown');
  await expect(sheet.getByRole('radiogroup', { name: 'Image theme' }).getByRole('radio', { name: 'Black' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect.poll(async () => (await inspect(img)).bg, { timeout: 15_000 }).toEqual([0, 0, 0]);
});

test('Editorial card: re-set serif text on paper; tap a sentence to highlight it', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  await goToPage(page, 3);
  await selectSpan(page, 3, 'Chapter Two', 'argued for months');
  await page.getByRole('button', { name: 'Clip from selection' }).dispatchEvent('pointerdown');
  const sheet = page.getByRole('dialog', { name: 'Export p. 3' });
  await sheet.getByRole('radiogroup', { name: 'Image theme' }).getByRole('radio', { name: 'Light' }).click();
  await sheet.getByRole('radio', { name: 'Editorial' }).click();
  await expect(sheet.getByRole('radio', { name: 'Light' })).toHaveText('Paper');
  const img = sheet.getByRole('img', { name: 'Clip preview' });
  await expect.poll(async () => (await inspect(img)).bg, { timeout: 15_000 }).toEqual([0xf8, 0xf3, 0xea]);
  await dump(img, 'editorial-paper');
  const before = await inspect(img);
  expect(Math.abs(before.left - before.right)).toBeLessThan(before.w * 0.12); // ragged right, but centred block

  // tap down the left side of the card until a sentence lights up
  const box = (await img.boundingBox())!;
  for (let f = 0.2; f < 0.8; f += 0.04) {
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * f);
    if (await sheet.getByText('1 highlighted').isVisible()) break;
  }
  await expect(sheet.getByText('1 highlighted')).toBeVisible();
  // the highlight is amber on paper: some pixels are now distinctly yellow
  await expect
    .poll(() =>
      img.evaluate(async (el: HTMLImageElement) => {
        await el.decode();
        const c = document.createElement('canvas');
        c.width = el.naturalWidth;
        c.height = el.naturalHeight;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(el, 0, 0);
        const px = ctx.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < px.length; i += 16) if (px[i] > 230 && px[i + 2] < 160) n++;
        return n;
      }),
    )
    .toBeGreaterThan(500);
  await dump(img, 'editorial-highlight');
  await sheet.getByRole('radio', { name: 'Black' }).click();
  await expect.poll(async () => (await inspect(img)).bg, { timeout: 15_000 }).toEqual([0, 0, 0]);
  await dump(img, 'editorial-black');
});

test('4:5 and 9:16 split a long clip into a carousel at paragraph breaks', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  await goToPage(page, 3);
  await showChrome(page);
  await page.getByRole('button', { name: 'Clip passage' }).click();
  const bar = page.getByRole('toolbar', { name: 'Clip passage' });
  await tapText(page, 3, 'Chapter Two');
  await tapText(page, 7, 'Nvidia opened new offices'); // the curtain stretches across pages 3–7
  await expect(bar.getByTestId('clip-span')).toHaveText('pp. 3–7');
  await bar.getByRole('button', { name: 'Export…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Export pp. 3–7' });
  await sheet.getByRole('radio', { name: 'Original' }).click();
  await sheet.getByRole('radio', { name: '4:5 Feed' }).click();
  const first = sheet.getByRole('img', { name: /^Clip preview 1 of \d$/ });
  await expect(first).toBeVisible({ timeout: 15_000 });
  const n = Number(/of (\d)/.exec((await first.getAttribute('alt'))!)![1]);
  expect(n).toBeGreaterThanOrEqual(2);
  expect(n).toBeLessThanOrEqual(4);
  for (let i = 1; i <= n; i++) {
    const s = await inspect(sheet.getByRole('img', { name: `Clip preview ${i} of ${n}` }));
    expect([s.w, s.h]).toEqual([1440, 1800]);
    await dump(sheet.getByRole('img', { name: `Clip preview ${i} of ${n}` }), `feed-${i}`);
  }
  const downloads: Download[] = [];
  page.on('download', (d) => downloads.push(d));
  await sheet.getByRole('button', { name: 'Download all' }).click();
  await expect.poll(() => downloads.length).toBe(n);
  expect(downloads.map((d) => d.suggestedFilename())).toEqual(
    Array.from({ length: n }, (_, i) => expect.stringMatching(new RegExp(`-${i + 1}\\.png$`))),
  );

  await sheet.getByRole('radio', { name: '9:16 Story' }).click();
  const story = sheet.getByRole('img', { name: /^Clip preview 1 of \d$/ });
  await expect.poll(async () => [(await inspect(story)).w, (await inspect(story)).h], { timeout: 15_000 }).toEqual([1440, 2560]);
  await dump(story, 'story-1');
  // the choice is remembered next time
  await page.keyboard.press('Escape');
  await bar.getByRole('button', { name: 'Export…' }).click();
  await expect(sheet.getByRole('radio', { name: '9:16 Story' })).toHaveAttribute('aria-checked', 'true');
});

test('Clips vault: combine clips from far-apart pages into one Mini-PDF', async ({ page }) => {
  await importChronicle(page);
  await openChronicle(page);
  for (const [n, a, b] of [
    [8, 'The data centre', 'by the thousand'],
    [3, 'In 2008 a packaging', 'months of heat'],
  ] as const) {
    await goToPage(page, n);
    await selectSpan(page, n, a, b);
    await page.getByRole('button', { name: 'Clip from selection' }).dispatchEvent('pointerdown');
    const sheet = page.getByRole('dialog', { name: `Export p. ${n}` });
    await sheet.getByRole('button', { name: 'Save' }).click();
    await expect(sheet.getByRole('button', { name: 'Saved' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  }
  await page.waitForTimeout(600); // the reader ignores taps for 0.5 s after a selection
  const panel = await openSettings(page);
  await panel.getByRole('button', { name: 'Clips' }).click();
  const clips = page.getByRole('dialog', { name: 'Clips' });
  await clips.getByRole('button', { name: 'Select' }).click();
  await expect(clips.getByRole('button', { name: 'Pick 2 or more clips' })).toBeDisabled();
  for (const box of await clips.getByRole('checkbox').all()) await box.click();
  await clips.getByRole('button', { name: 'Combine 2 into Mini-PDF' }).click();
  const dl = page.waitForEvent('download');
  await clips.getByRole('link', { name: 'Download PDF' }).click();
  const pdf = await bytes(await dl);
  const doc = await PDFDocument.load(pdf);
  expect(doc.getPageCount()).toBe(3); // contents + one cropped page per clip
  expect(doc.getTitle()).toBe('The Chip Chronicle: 2 clips');
  // in book order (p. 3 first), each page cropped to its passage
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const d = await pdfjs.getDocument({ data: new Uint8Array(pdf), useWorkerFetch: false, isEvalSupported: false }).promise;
  const text = async (i: number) =>
    (await (await d.getPage(i)).getTextContent()).items.map((it) => ('str' in it ? it.str : '')).join(' ');
  expect(await text(1)).toContain('2 clips');
  expect(await text(2)).toContain('packaging flaw');
  expect(await text(3)).toContain('data centre');
  for (const p of doc.getPages().slice(1)) expect(p.getCropBox().height).toBeLessThan(595 * 0.3);
});
