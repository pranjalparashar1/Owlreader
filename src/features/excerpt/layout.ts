/**
 * Page geometry for Clip & Export, from pdf.js text items: lines with their vertical extent
 * (as fractions of the page height, top = 0), font size and style, which lines are page
 * furniture (running headers, page numbers), and where paragraph boundaries fall.
 */
import { pdfjs, type PDFDocumentProxy, type PDFPageProxy } from '../../lib/pdfjs';
import type { ClipRange } from '../../types';

export interface Span {
  text: string;
  bold: boolean;
  italic: boolean;
}

export interface Line {
  /** Fractions of the page height (0 = top). */
  top: number;
  bottom: number;
  baseline: number;
  /** Fractions of the page width. */
  x0: number;
  x1: number;
  /** Font size in PDF points. */
  size: number;
  spans: Span[];
  text: string;
  /**
   * Left edge of each character of `text` (fractions of the page width), plus the line's right
   * edge at the end: `xs.length === text.length + 1`. Estimated within each text item.
   */
  xs: number[];
  furniture: boolean;
}

export interface PageLayout {
  page: number;
  /** Size at scale 1, in PDF points (rotation applied). */
  width: number;
  height: number;
  /** Body lines (not furniture), top to bottom. */
  lines: Line[];
  furniture: Line[];
  /** Median distance between consecutive body baselines, as a fraction of the page height. */
  pitch: number;
  /** Median body font size in points. */
  bodySize: number;
  /** Left edge of body text (fraction of width): lines starting right of it are indented. */
  left: number;
}

interface RawItem {
  str: string;
  transform: number[];
  width: number;
  fontName: string;
  hasEOL?: boolean;
}

const median = (xs: number[], fallback: number) => {
  if (!xs.length) return fallback;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Real font names (e.g. "Times-Bold") once the page's fonts are loaded; pdf.js ids otherwise. */
function fontStyle(page: PDFPageProxy, id: string, withFonts: boolean) {
  let name = id;
  if (withFonts) {
    try {
      const f = page.commonObjs.has(id) ? (page.commonObjs.get(id) as { name?: string }) : null;
      if (f?.name) name = f.name;
    } catch {
      /* not loaded */
    }
  }
  return { bold: /bold|black|heavy|semibold|demi/i.test(name), italic: /italic|oblique/i.test(name) };
}

const cache = new WeakMap<PDFDocumentProxy, Map<string, Promise<PageLayout>>>();

/**
 * `withFonts` loads the page's operator list first so bold/italic can be read from font names
 * (export only: it costs a parse of the page's drawing commands).
 */
export function pageLayout(doc: PDFDocumentProxy, n: number, withFonts = false): Promise<PageLayout> {
  let m = cache.get(doc);
  if (!m) cache.set(doc, (m = new Map()));
  const key = `${n}|${withFonts}`;
  let p = m.get(key);
  if (!p) {
    p = buildLayout(doc, n, withFonts);
    m.set(key, p);
  }
  return p;
}

async function buildLayout(doc: PDFDocumentProxy, n: number, withFonts: boolean): Promise<PageLayout> {
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  if (withFonts) await page.getOperatorList().catch(() => null);
  const content = await page.getTextContent();
  const W = vp.width;
  const H = vp.height;

  const items = (content.items as RawItem[])
    .filter((it) => typeof it.str === 'string' && it.str.length > 0)
    .map((it) => {
      const t = pdfjs.Util.transform(vp.transform, it.transform);
      const size = Math.hypot(t[2], t[3]) || Math.hypot(it.transform[2], it.transform[3]) || 10;
      const x = t[4];
      const base = t[5];
      return { it, size, x, base, w: it.width * (vp.scale || 1), ...fontStyle(page, it.fontName, withFonts) };
    })
    .sort((a, b) => a.base - b.base || a.x - b.x);

  // group into lines by baseline
  const groups: Array<typeof items> = [];
  for (const item of items) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g[0].base - item.base) < Math.max(2, g[0].size * 0.45)) g.push(item);
    else groups.push([item]);
  }

  const all: Line[] = groups.map((g) => {
    g.sort((a, b) => a.x - b.x);
    const size = Math.max(...g.map((i) => i.size));
    const base = median(
      g.map((i) => i.base),
      g[0].base,
    );
    const spans: Span[] = [];
    let text = '';
    let lastEnd = -Infinity;
    // the normalized text (whitespace collapsed, trimmed) with a position per character
    let norm = '';
    const xs: number[] = [];
    for (const i of g) {
      let str = i.it.str;
      if (!str.trim() && !str) continue;
      const gapSpace = text && !/\s$/.test(text) && !/^\s/.test(str) && i.x - lastEnd > i.size * 0.15;
      if (gapSpace && norm && !norm.endsWith(' ')) {
        norm += ' ';
        xs.push(lastEnd / W);
      }
      const chars = [...i.it.str];
      chars.forEach((ch, k) => {
        const c = /\s/.test(ch) ? ' ' : ch;
        if (c === ' ' && (!norm || norm.endsWith(' '))) return;
        norm += c;
        for (let u = 0; u < c.length; u++) xs.push((i.x + (i.w * k) / chars.length) / W);
      });
      // a visible gap between items is a word space the PDF didn't encode
      if (gapSpace) str = ` ${str}`;
      text += str;
      lastEnd = i.x + i.w;
      const prev = spans[spans.length - 1];
      if (prev && prev.bold === i.bold && prev.italic === i.italic) prev.text += str;
      else spans.push({ text: str, bold: i.bold, italic: i.italic });
    }
    const x1 = Math.max(...g.map((i) => i.x + i.w)) / W;
    while (norm.endsWith(' ')) {
      norm = norm.slice(0, -1);
      xs.pop();
    }
    xs.push(x1);
    return {
      top: (base - size * 0.82) / H,
      bottom: (base + size * 0.24) / H,
      baseline: base / H,
      x0: g[0].x / W,
      x1,
      size,
      spans,
      text: norm,
      xs,
      furniture: false,
    };
  });
  const textLines = all.filter((l) => l.text);

  // furniture: page numbers and running headers/footers in the top or bottom 10%,
  // set apart from the body by a clear gap
  for (let i = 0; i < textLines.length; i++) {
    const l = textLines[i];
    const inBand = l.top < 0.1 || l.bottom > 0.9;
    if (!inBand) continue;
    const words = l.text.split(' ').length;
    const letters = l.text.replace(/[^\p{L}]/gu, '');
    const pageNo = l.text.length <= 8 && /^[\d\s.–—-]+$|^[ivxlcdm]+\.?$/i.test(l.text);
    const caps = letters.length >= 3 && letters === letters.toUpperCase() && words <= 8;
    const neighbour = l.top < 0.1 ? textLines[i + 1] : textLines[i - 1];
    const gap = neighbour ? Math.abs((l.top < 0.1 ? neighbour.top - l.bottom : l.top - neighbour.bottom) * H) : Infinity;
    const apart = gap > l.size * 1.6;
    if (pageNo || ((caps || words <= 6) && apart)) l.furniture = true;
  }
  const lines = textLines.filter((l) => !l.furniture);
  const pitches: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const d = lines[i].baseline - lines[i - 1].baseline;
    if (d > 0 && Math.abs(lines[i].size - lines[i - 1].size) < 1) pitches.push(d);
  }
  const bodySize = median(
    lines.map((l) => l.size),
    10,
  );
  return {
    page: n,
    width: W,
    height: H,
    lines,
    furniture: textLines.filter((l) => l.furniture),
    pitch: median(pitches, (bodySize * 1.4) / H),
    bodySize,
    left: lines.length ? Math.min(...lines.map((l) => l.x0)) : 0,
  };
}

/** Boundaries a handle may rest on: between lines, and (preferred) between paragraphs. */
export function boundaries(layout: PageLayout): { lines: number[]; paragraphs: number[] } {
  const { lines: ls, pitch, bodySize, left } = layout;
  const lines: number[] = [];
  const paragraphs: number[] = [];
  if (!ls.length) return { lines, paragraphs };
  const pad = pitch * 0.25;
  lines.push(Math.max(0, ls[0].top - pad));
  paragraphs.push(Math.max(0, ls[0].top - pad));
  for (let i = 1; i < ls.length; i++) {
    const a = ls[i - 1];
    const b = ls[i];
    const mid = (a.bottom + b.top) / 2;
    lines.push(mid);
    const gap = b.baseline - a.baseline;
    const indent = b.x0 - left > (bodySize * 0.8) / layout.width;
    const heading = b.size > bodySize * 1.15 || a.size > bodySize * 1.15;
    if (gap > pitch * 1.3 || indent || heading) paragraphs.push(mid);
  }
  const end = Math.min(1, ls[ls.length - 1].bottom + pad);
  lines.push(end);
  paragraphs.push(end);
  return { lines, paragraphs };
}

/**
 * The paragraph (or heading) under a point on the page, as its top and bottom boundary, or null
 * when the point is above the first line or below the last one by more than a line.
 */
export function paragraphAt(layout: PageLayout, y: number): { top: number; bottom: number } | null {
  const { paragraphs } = boundaries(layout);
  if (paragraphs.length < 2) return null;
  const slack = layout.pitch;
  if (y < paragraphs[0] - slack || y > paragraphs[paragraphs.length - 1] + slack) return null;
  for (let i = 1; i < paragraphs.length; i++) {
    if (y <= paragraphs[i] || i === paragraphs.length - 1) return { top: paragraphs[i - 1], bottom: paragraphs[i] };
  }
  return null;
}

/** Soft snap: a paragraph boundary if one is close, else the nearest line boundary (never mid-line). */
export function snapY(layout: PageLayout, y: number): number {
  const { lines, paragraphs } = boundaries(layout);
  if (!lines.length) return y;
  const nearest = (xs: number[]) => xs.reduce((best, v) => (Math.abs(v - y) < Math.abs(best - y) ? v : best), xs[0]);
  const p = nearest(paragraphs);
  if (Math.abs(p - y) < 0.045) return p;
  const l = nearest(lines);
  return Math.abs(l - y) < 0.06 ? l : y;
}

/** A selection's range widened to whole lines: from the top of its first line to the bottom of its last. */
export async function lineBounds(doc: PDFDocumentProxy, r: ClipRange): Promise<ClipRange> {
  const [a, b] = await Promise.all([pageLayout(doc, r.start.page), pageLayout(doc, r.end.page)]);
  const first = a.lines.find((l) => l.bottom > r.start.y);
  const last = [...b.lines].reverse().find((l) => l.top < r.end.y);
  const start = first ? { page: r.start.page, y: Math.max(0, first.top - a.pitch * 0.25) } : r.start;
  const end = last ? { page: r.end.page, y: Math.min(1, last.bottom + b.pitch * 0.25) } : r.end;
  return start.page < end.page || start.y < end.y ? { start, end } : r;
}

/** Each spanned page with the part of it inside the clip. */
export function slices(range: ClipRange): Array<{ page: number; top: number; bottom: number }> {
  const out = [];
  for (let p = range.start.page; p <= range.end.page; p++) {
    out.push({
      page: p,
      top: p === range.start.page ? range.start.y : 0,
      bottom: p === range.end.page ? range.end.y : 1,
    });
  }
  return out;
}

export const MAX_CLIP_PAGES = 5;

export const spanLabel = (r: { start: { page: number }; end: { page: number } }) =>
  r.start.page === r.end.page ? `p. ${r.start.page}` : `pp. ${r.start.page}–${r.end.page}`;
