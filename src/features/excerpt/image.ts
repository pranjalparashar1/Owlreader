/**
 * The "void-eater" stitcher: renders only the clipped band of each spanned page, blanks running
 * headers and page numbers, trims the empty margin rows at each page break, and stacks the inked
 * bands into one continuous image with even spacing, so a passage split across pages reads as one.
 */
import type { PDFDocumentProxy } from '../../lib/pdfjs';
import type { ClipRange } from '../../types';
import { pageLayout, slices, type PageLayout } from './layout';

/** Inked bounds of a slice, as page fractions. */
export interface Trim {
  page: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** Blank bands inside the slice, taller than a few lines (page fractions): collapsed in images. */
  holes: Array<{ top: number; bottom: number }>;
  layout: PageLayout;
}

const INK = 235; // a pixel darker than this on any channel counts as ink

export async function render(doc: PDFDocumentProxy, n: number, scale: number) {
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const task = page.render({ canvas, viewport: vp, background: '#ffffff' });
  await task.promise;
  return { canvas, page, task, transform: vp.transform };
}

/** Paint over running headers and page numbers so neither the trim nor the image keeps them. */
export function blankFurniture(canvas: HTMLCanvasElement, layout: PageLayout) {
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  for (const f of layout.furniture) {
    const pad = 0.004;
    ctx.fillRect(0, (f.top - pad) * canvas.height, canvas.width, (f.bottom - f.top + pad * 2) * canvas.height);
  }
}

/** A blank band taller than this many lines inside a clip is closed up in the image. */
export const HOLE_LINES = 3;
const ASTRAY = 0.004; // ink outside the text column counts (a figure, a wide table) above this share of the slice

/**
 * The inked box of a band of the page. Left and right come from the text column when the page has
 * text (`textX`, page fractions): a book's gutter shadow, a binding rule or a stray mark beside the
 * column would otherwise pull one side out and leave the margins uneven. Ink outside the column
 * still counts when there's enough of it to be a figure.
 */
function inkBox(canvas: HTMLCanvasElement, y0: number, y1: number, textX: { x0: number; x1: number } | null, minHole: number) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const w = canvas.width;
  const top = Math.max(0, Math.floor(y0));
  const h = Math.max(0, Math.min(canvas.height, Math.ceil(y1)) - top);
  if (!h) return null;
  const px = ctx.getImageData(0, top, w, h).data;
  const cols = new Uint32Array(w);
  const isInk = (i: number) => px[i] < INK || px[i + 1] < INK || px[i + 2] < INK;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) if (isInk(row + x * 4)) cols[x]++;
  }
  let inkL = 0;
  while (inkL < w && !cols[inkL]) inkL++;
  if (inkL === w) return null;
  let inkR = w - 1;
  while (inkR > inkL && !cols[inkR]) inkR--;
  let left = inkL;
  let right = inkR + 1;
  if (textX) {
    const tl = Math.max(0, Math.floor(textX.x0 * w) - 2);
    const tr = Math.min(w, Math.ceil(textX.x1 * w) + 2);
    // a figure is wide and dense; a gutter rule, crop mark or margin note is neither
    const figure = (x0: number, x1: number) => {
      let ink = 0;
      let wide = 0;
      for (let x = x0; x < x1; x++) {
        ink += cols[x];
        if (cols[x]) wide++;
      }
      return ink > w * h * ASTRAY && wide > Math.max(6, w * 0.04);
    };
    if (!figure(0, tl)) left = Math.max(inkL, tl);
    if (!figure(tr, w)) right = Math.min(inkR + 1, tr);
  }
  let first = -1;
  let last = -1;
  const holes: Array<{ top: number; bottom: number }> = [];
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = left; x < right; x++) {
      if (isInk(row + x * 4)) {
        if (first < 0) first = y;
        else if (y - last - 1 >= minHole) holes.push({ top: top + last + 1, bottom: top + y });
        last = y;
        break;
      }
    }
  }
  if (first < 0) return null;
  return { top: top + first, bottom: top + last + 1, left, right, holes };
}

/**
 * Where the ink really is inside each slice (furniture excluded), from a cheap scale-1 render.
 * Shared with the PDF export so both trim the same way.
 */
export async function trimSlices(doc: PDFDocumentProxy, range: ClipRange): Promise<Trim[]> {
  const out: Trim[] = [];
  for (const s of slices(range)) {
    const layout = await pageLayout(doc, s.page);
    const { canvas } = await render(doc, s.page, 1);
    blankFurniture(canvas, layout);
    const inSlice = layout.lines.filter((l) => (l.top + l.bottom) / 2 >= s.top && (l.top + l.bottom) / 2 <= s.bottom);
    const textX = inSlice.length
      ? { x0: Math.min(...inSlice.map((l) => l.x0)), x1: Math.max(...inSlice.map((l) => l.x1)) }
      : null;
    const H = canvas.height;
    const box = inkBox(canvas, s.top * H, s.bottom * H, textX, layout.pitch * H * HOLE_LINES);
    const W = canvas.width;
    canvas.width = 0;
    if (!box) continue;
    out.push({
      page: s.page,
      top: box.top / H,
      bottom: box.bottom / H,
      left: box.left / W,
      right: box.right / W,
      holes: box.holes.map((g) => ({ top: g.top / H, bottom: g.bottom / H })),
      layout,
    });
  }
  return out;
}

export const ENDS_SENTENCE = /[.!?:;"”’)\]]$/;

/** Space between two stitched bands: a line gap mid-paragraph, a paragraph gap between paragraphs. */
export function gapBetween(a: Trim, b: Trim) {
  const lastA = [...a.layout.lines].reverse().find((l) => (l.top + l.bottom) / 2 <= a.bottom);
  const firstB = b.layout.lines.find((l) => (l.top + l.bottom) / 2 >= b.top);
  const pitchPt = a.layout.pitch * a.layout.height;
  const lineGap = Math.max(2, pitchPt - a.layout.bodySize * 0.95);
  const indent = firstB ? firstB.x0 - b.layout.left > (b.layout.bodySize * 0.8) / b.layout.width : false;
  const heading = !!firstB && firstB.size > b.layout.bodySize * 1.15;
  if (heading) return lineGap + pitchPt * 1.2; // a new chapter or section keeps its space above
  const newPara = !lastA || !firstB || (ENDS_SENTENCE.test(lastA.text) && indent);
  return newPara ? lineGap + pitchPt * 0.6 : lineGap; // in points
}
