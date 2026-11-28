/**
 * Standalone mini-PDFs with pdf-lib (only ever loaded from here, on demand).
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
  out.setCreator('OwlReader');
  out.setProducer('OwlReader');
}

export async function exportCroppedPdf(data: ArrayBuffer, doc: PDFDocumentProxy, range: ClipRange, c: Citation) {
  const trims = await trimSlices(doc, range);
  if (!trims.length) throw new Error('Nothing to export: the clip is empty.');
  const src = await PDFDocument.load(data.slice(0), { ignoreEncryption: true, updateMetadata: false });
  const out = await PDFDocument.create();
  const pages = await out.copyPages(
    src,
    trims.map((t) => t.page - 1),
  );
  pages.forEach((p, i) => {
    const t = trims[i];
    out.addPage(p);
    if (p.getRotation().angle % 360 !== 0) return; // rotated pages are kept whole rather than cropped wrongly
    const box = p.getCropBox();
    const pad = 6; // pt of breathing room around the ink
    const x0 = Math.max(box.x, box.x + t.left * box.width - pad);
    const x1 = Math.min(box.x + box.width, box.x + t.right * box.width + pad);
    const yTop = Math.min(box.y + box.height, box.y + (1 - t.top) * box.height + pad);
    const yBot = Math.max(box.y, box.y + (1 - t.bottom) * box.height - pad);
    for (const set of [p.setMediaBox, p.setCropBox, p.setTrimBox, p.setBleedBox, p.setArtBox]) {
      set.call(p, x0, yBot, x1 - x0, yTop - yBot);
    }
  });
  meta(out, c);
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
