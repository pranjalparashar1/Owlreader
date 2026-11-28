/**
 * The "void-eater" stitcher: renders only the clipped band of each spanned page, blanks running
 * headers and page numbers, trims the empty margin rows at each page break, and stacks the inked
 * bands into one continuous image with even spacing, so a passage split across pages reads as one.
 */
import type { PDFDocumentProxy } from '../../lib/pdfjs';
import { PAGE_BG, tintCanvas } from '../../lib/tint';
import type { ClipRange, ReaderTheme } from '../../types';
import { pageLayout, slices, type PageLayout } from './layout';

/** Inked bounds of a slice, as page fractions. */
export interface Trim {
  page: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  layout: PageLayout;
}

const INK = 235; // a pixel darker than this on any channel counts as ink

async function render(doc: PDFDocumentProxy, n: number, scale: number) {
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  await page.render({ canvas, viewport: vp, background: '#ffffff' }).promise;
  return canvas;
}

/** Paint over running headers and page numbers so neither the trim nor the image keeps them. */
function blankFurniture(canvas: HTMLCanvasElement, layout: PageLayout) {
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  for (const f of layout.furniture) {
    const pad = 0.004;
    ctx.fillRect(0, (f.top - pad) * canvas.height, canvas.width, (f.bottom - f.top + pad * 2) * canvas.height);
  }
}

function inkBox(canvas: HTMLCanvasElement, y0: number, y1: number) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const w = canvas.width;
  const top = Math.max(0, Math.floor(y0));
  const h = Math.max(0, Math.min(canvas.height, Math.ceil(y1)) - top);
  if (!h) return null;
  const px = ctx.getImageData(0, top, w, h).data;
  let first = -1;
  let last = -1;
  let left = w;
  let right = -1;
  for (let y = 0; y < h; y++) {
    let rowInk = false;
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = row + x * 4;
      if (px[i] < INK || px[i + 1] < INK || px[i + 2] < INK) {
        rowInk = true;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
    if (rowInk) {
      if (first < 0) first = y;
      last = y;
    }
  }
  if (first < 0) return null;
  return { top: top + first, bottom: top + last + 1, left, right: right + 1 };
}

/**
 * Where the ink really is inside each slice (furniture excluded), from a cheap scale-1 render.
 * Shared with the PDF export so both trim the same way.
 */
export async function trimSlices(doc: PDFDocumentProxy, range: ClipRange): Promise<Trim[]> {
  const out: Trim[] = [];
  for (const s of slices(range)) {
    const layout = await pageLayout(doc, s.page);
    const canvas = await render(doc, s.page, 1);
    blankFurniture(canvas, layout);
    const box = inkBox(canvas, s.top * canvas.height, s.bottom * canvas.height);
    const { width: W, height: H } = canvas;
    canvas.width = 0;
    if (!box) continue;
    out.push({ page: s.page, top: box.top / H, bottom: box.bottom / H, left: box.left / W, right: box.right / W, layout });
  }
  return out;
}

const ENDS_SENTENCE = /[.!?:;"”’)\]]$/;

/** Space between two stitched bands: a line gap mid-paragraph, a paragraph gap between paragraphs. */
function gapBetween(a: Trim, b: Trim) {
  const lastA = [...a.layout.lines].reverse().find((l) => (l.top + l.bottom) / 2 <= a.bottom);
  const firstB = b.layout.lines.find((l) => (l.top + l.bottom) / 2 >= b.top);
  const pitchPt = a.layout.pitch * a.layout.height;
  const lineGap = Math.max(2, pitchPt - a.layout.bodySize * 0.95);
  const indent = firstB ? firstB.x0 - b.layout.left > (b.layout.bodySize * 0.8) / b.layout.width : false;
  const newPara = !lastA || !firstB || (ENDS_SENTENCE.test(lastA.text) && indent);
  return newPara ? lineGap + pitchPt * 0.6 : lineGap; // in points
}

export interface ImageOptions {
  theme: ReaderTheme;
  /** Attribution text for the footer, or null for none. */
  footer: string | null;
  /** Width of a full page in the output, in px (≈2× a phone's CSS width). */
  pageWidthPx?: number;
}

const MAX_PIXELS = 15_000_000; // iOS caps a canvas at 16.7 MP

export async function exportImage(doc: PDFDocumentProxy, range: ClipRange, opts: ImageOptions): Promise<Blob> {
  const trims = await trimSlices(doc, range);
  if (!trims.length) throw new Error('Nothing to export: the clip is empty.');
  const left = Math.min(...trims.map((t) => t.left));
  const right = Math.max(...trims.map((t) => t.right));
  const ptW = trims[0].layout.width;
  let scale = (opts.pageWidthPx ?? 1400) / ptW;
  const gapsPt = trims.slice(1).map((t, i) => gapBetween(trims[i], t));
  const heightPt = trims.reduce((s, t) => s + (t.bottom - t.top) * t.layout.height, 0) + gapsPt.reduce((s, g) => s + g, 0);
  const margin = 28; // pt
  const footerPt = opts.footer ? 34 : 0;
  const wPt = (right - left) * ptW + margin * 2;
  const hPt = heightPt + margin * 2 + footerPt;
  scale = Math.min(scale, Math.sqrt(MAX_PIXELS / (wPt * hPt)));

  const out = document.createElement('canvas');
  out.width = Math.round(wPt * scale);
  out.height = Math.round(hPt * scale);
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);

  let y = margin * scale;
  for (let i = 0; i < trims.length; i++) {
    const t = trims[i];
    const page = await render(doc, t.page, scale);
    blankFurniture(page, t.layout);
    const sx = left * page.width;
    const sy = t.top * page.height;
    const sw = (right - left) * page.width;
    const sh = (t.bottom - t.top) * page.height;
    ctx.drawImage(page, sx, sy, sw, sh, margin * scale, y, sw, sh);
    page.width = 0;
    y += sh + (gapsPt[i] ?? 0) * scale;
  }

  const tinted = tintCanvas(out, opts.theme);
  if (opts.footer) {
    const c = tinted.getContext('2d')!;
    const fy = tinted.height - footerPt * scale;
    c.fillStyle = PAGE_BG[opts.theme];
    c.fillRect(0, fy - 2, tinted.width, footerPt * scale + 2);
    c.fillStyle = opts.theme === 'dark' ? '#3a3a3a' : opts.theme === 'sepia' ? '#d9ccb0' : '#e7e2da';
    c.fillRect(margin * scale, fy, tinted.width - margin * 2 * scale, Math.max(1, scale * 0.6));
    c.fillStyle = opts.theme === 'dark' ? '#a8a29e' : opts.theme === 'sepia' ? '#7a6a50' : '#78716c';
    c.font = `${Math.round(9.5 * scale)}px Georgia, 'Times New Roman', serif`;
    c.textBaseline = 'middle';
    let text = opts.footer;
    const maxW = tinted.width - margin * 2 * scale;
    while (c.measureText(text).width > maxW && text.length > 8) text = `${text.slice(0, -2).trimEnd()}…`;
    c.fillText(text, margin * scale, fy + (footerPt * scale) / 2);
  }
  const blob = await new Promise<Blob | null>((res) => tinted.toBlob(res, 'image/png'));
  tinted.width = 0;
  if (out !== tinted) out.width = 0;
  if (!blob) throw new Error("Couldn't create the image.");
  return blob;
}
