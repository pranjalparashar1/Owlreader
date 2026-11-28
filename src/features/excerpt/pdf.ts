/**
 * Standalone mini-PDFs with pdf-lib (only ever loaded from here, on demand).
 * - Dossier: several saved clips stitched into one cropped PDF behind a contents page.
 * - Cropped facsimile: the spanned pages copied from the book, each cropped to its inked part of
 *   the clip. Vector, searchable, keeps diagrams and tables, tiny.
 * - Clean text: the passage re-typeset as one continuous page, so no page break splits it.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import type { PDFDocumentProxy } from '../../lib/pdfjs';
import type { ClipRange } from '../../types';
import { trimSlices } from './image';
import { spanLabel } from './layout';
import type { Block, Citation } from './text';

function meta(out: PDFDocument, c: Citation) {
  out.setTitle(`${c.title}, ${spanLabel(c.range)}`);
  if (c.author) out.setAuthor(c.author);
  out.setSubject(`Excerpt from ${c.title}`);
  out.setCreator('Owl');
  out.setProducer('Owl');
}

/** Copies the spanned pages of a clip into `out`, each cut down to its inked part. */
async function addCroppedPages(out: PDFDocument, src: PDFDocument, doc: PDFDocumentProxy, range: ClipRange) {
  const trims = await trimSlices(doc, range);
  if (!trims.length) return 0;
  const pages = await out.copyPages(
    src,
    trims.map((t) => t.page - 1),
  );
  pages.forEach((p, i) => {
    const t = trims[i];
    out.addPage(p);
    if (p.getRotation().angle % 360 !== 0) return; // rotated pages are kept whole rather than cropped wrongly
    const box = p.getCropBox();
    // even breathing room on every side of the text block
    const pad = 12;
    const x0 = Math.max(box.x, box.x + t.left * box.width - pad);
    const x1 = Math.min(box.x + box.width, box.x + t.right * box.width + pad);
    const yTop = Math.min(box.y + box.height, box.y + (1 - t.top) * box.height + pad);
    const yBot = Math.max(box.y, box.y + (1 - t.bottom) * box.height - pad);
    for (const set of [p.setMediaBox, p.setCropBox, p.setTrimBox, p.setBleedBox, p.setArtBox]) {
      set.call(p, x0, yBot, x1 - x0, yTop - yBot);
    }
  });
  return pages.length;
}

const loadSource = (data: ArrayBuffer) => PDFDocument.load(data.slice(0), { ignoreEncryption: true, updateMetadata: false });

export async function exportCroppedPdf(data: ArrayBuffer, doc: PDFDocumentProxy, range: ClipRange, c: Citation) {
  const out = await PDFDocument.create();
  if (!(await addCroppedPages(out, await loadSource(data), doc, range))) throw new Error('Nothing to export: the clip is empty.');
  meta(out, c);
  return out.save();
}

export interface DossierClip {
  range: ClipRange;
  title: string;
}

/**
 * Several saved clips, however far apart, as one briefing: a contents page, then each clip's
 * cropped pages in book order. Still vector and searchable.
 */
export async function exportDossier(
  data: ArrayBuffer,
  doc: PDFDocumentProxy,
  clips: DossierClip[],
  book: { title: string; author?: string },
) {
  const ordered = [...clips].sort((a, b) => a.range.start.page - b.range.start.page || a.range.start.y - b.range.start.y);
  const out = await PDFDocument.create();
  const [regular, bold, italic] = await Promise.all([
    out.embedFont(StandardFonts.TimesRoman),
    out.embedFont(StandardFonts.TimesRomanBold),
    out.embedFont(StandardFonts.TimesRomanItalic),
  ]);
  const W = 420;
  const M = 44;
  const ink = rgb(0.1, 0.09, 0.08);
  const muted = rgb(0.42, 0.4, 0.38);
  const rows = ordered.map((c, i) => ({
    lines: wrap(bold, 12, encodable(bold, `${i + 1}. ${c.title}`), W - M * 2 - 70),
    pages: spanLabel(c.range),
  }));
  const titleLines = wrap(bold, 18, encodable(bold, book.title), W - M * 2);
  const H = Math.max(300, M * 2 + titleLines.length * 24 + 40 + rows.reduce((h, r) => h + r.lines.length * 16 + 8, 0) + 30);
  const cover = out.addPage([W, H]);
  let y = H - M;
  for (const l of titleLines) {
    y -= 22;
    cover.drawText(l, { x: M, y, size: 18, font: bold, color: ink });
  }
  y -= 18;
  const sub = `${book.author ? `${book.author} · ` : ''}${clips.length} clips`;
  cover.drawText(encodable(italic, sub), { x: M, y, size: 11, font: italic, color: muted });
  y -= 14;
  cover.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: rgb(0.85, 0.83, 0.8) });
  y -= 10;
  for (const r of rows) {
    y -= 8;
    r.lines.forEach((l, k) => {
      y -= 16;
      cover.drawText(l, { x: M, y, size: 12, font: k ? regular : bold, color: ink });
      if (!k)
        cover.drawText(r.pages, {
          x: W - M - regular.widthOfTextAtSize(r.pages, 11),
          y,
          size: 11,
          font: regular,
          color: muted,
        });
    });
  }
  cover.drawText('Made with Owl', { x: M, y: M / 2, size: 8, font: italic, color: muted });

  const src = await loadSource(data);
  let n = 0;
  for (const c of ordered) n += await addCroppedPages(out, src, doc, c.range);
  if (!n) throw new Error('Nothing to export: the clips are empty.');
  out.setTitle(`${book.title}: ${clips.length} clips`);
  if (book.author) out.setAuthor(book.author);
  out.setSubject(`Excerpts from ${book.title}`);
  out.setCreator('Owl');
  out.setProducer('Owl');
  return out.save();
}

/** Characters the standard fonts can't encode (WinAnsi) become close equivalents or '?'. */
function encodable(font: PDFFont, text: string) {
  const swaps: Record<string, string> = { '‐': '-', '‑': '-', '−': '-', '­': '', ﬁ: 'fi', ﬂ: 'fl' };
  let out = '';
  for (const ch of text) {
    const c = swaps[ch] ?? ch;
    try {
      font.encodeText(c);
      out += c;
    } catch {
      out += '?';
    }
  }
  return out;
}

function wrap(font: PDFFont, size: number, text: string, width: number) {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const trial = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(trial, size) > width && line) {
      lines.push(line);
      line = word;
    } else line = trial;
  }
  if (line) lines.push(line);
  return lines;
}

const plainInline = (md: string) => md.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1');

export async function exportCleanPdf(blocks: Block[], c: Citation) {
  const out = await PDFDocument.create();
  const [regular, bold, italic] = await Promise.all([
    out.embedFont(StandardFonts.TimesRoman),
    out.embedFont(StandardFonts.TimesRomanBold),
    out.embedFont(StandardFonts.TimesRomanItalic),
  ]);
  const W = 420;
  const M = 44;
  const width = W - M * 2;
  type Run = { font: PDFFont; size: number; text: string; gapBefore: number; color?: [number, number, number] };
  const runs: Run[] = [];
  for (const b of blocks) {
    const text = plainInline(b.plain);
    if (b.kind === 'heading') runs.push({ font: bold, size: 15, text, gapBefore: runs.length ? 14 : 0 });
    else runs.push({ font: regular, size: 12, text, gapBefore: runs.length ? (b.kind === 'item' ? 4 : 9) : 0 });
  }
  runs.push({
    font: italic,
    size: 10,
    text: `— ${c.title}${c.author ? `, ${c.author}` : ''}, ${spanLabel(c.range)}`,
    gapBefore: 18,
    color: [0.4, 0.38, 0.36],
  });

  // lay out first so the single page can be exactly as tall as the passage
  const laid: Array<{ run: Run; lines: string[] }> = runs.map((run) => ({
    run,
    lines: wrap(run.font, run.size, encodable(run.font, run.text), width),
  }));
  const lh = (r: Run) => r.size * 1.38;
  const contentH = laid.reduce((h, l) => h + l.run.gapBefore + l.lines.length * lh(l.run), 0);
  const H = Math.max(200, contentH + M * 2);
  const page = out.addPage([W, H]);
  let y = H - M;
  for (const { run, lines } of laid) {
    y -= run.gapBefore;
    for (const ln of lines) {
      y -= lh(run);
      page.drawText(ln, {
        x: M,
        y: y + run.size * 0.3,
        size: run.size,
        font: run.font,
        color: rgb(...(run.color ?? [0.1, 0.09, 0.08])),
      });
    }
  }
  meta(out, c);
  return out.save();
}
