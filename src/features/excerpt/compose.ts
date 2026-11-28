/**
 * Image export, in two steps.
 *
 * 1. Content: the passage as one tall bitmap the width of the text block, either the book's own
 *    pages stitched by the void-eater ("Original") or the passage re-set in serif type on a plain
 *    card ("Editorial"). Alongside it: where it may be split (paragraph and line breaks) and where
 *    each sentence sits, so a tapped sentence can be highlighted.
 * 2. Frames: that bitmap placed on one or more output images with even margins all round, a
 *    footer, and the chosen aspect ratio. A passage taller than one 4:5 or 9:16 frame is split at
 *    paragraph breaks into a carousel (at most MAX_SLIDES, so it fits one post on X).
 *
 * Content is built once per style/theme/ratio; changing the footer or the highlights only redraws
 * the frames. Every step is plain 2D canvas drawing (no ctx.filter, which iOS Safari lacks).
 */
import type { PDFDocumentProxy } from '../../lib/pdfjs';
import { PAGE_BG, isInverted, tintCanvas } from '../../lib/tint';
import { pageImageMatrices, toCanvasSpace } from '../../lib/pageImages';
import type { ClipRange, ReaderTheme } from '../../types';
import { ENDS_SENTENCE, blankFurniture, gapBetween, render, trimSlices, type Trim } from './image';
import { boundaries, type Line, type PageLayout } from './layout';
import type { Block } from './text';

export type Style = 'original' | 'editorial';
export type Ratio = 'auto' | '4:5' | '9:16';
export type Mark = 'amber' | 'white';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Sentence {
  id: number;
  text: string;
  /** One per line the sentence touches, in content pixels. */
  rects: Rect[];
}

export interface Content {
  canvas: HTMLCanvasElement;
  bg: string;
  theme: ReaderTheme;
  style: Style;
  /** Where the content may be split, in content pixels: 2 = between paragraphs, 1 = between lines. */
  breaks: Array<{ y: number; strength: 1 | 2 }>;
  sentences: Sentence[];
}

/** Output size per ratio: width, and height (0 = as tall as the passage). */
export const FRAME: Record<Ratio, { w: number; h: number }> = {
  auto: { w: 1600, h: 0 },
  '4:5': { w: 1440, h: 1800 },
  '9:16': { w: 1440, h: 2560 },
};
export const MAX_SLIDES = 4; // X takes four images per post
const MARGIN = 0.08; // of the frame width, on every side
const STORY_SAFE = 0.12; // of a 9:16 frame's height, top and bottom: Stories puts its own UI there
const MAX_PIXELS = 12_000_000; // iOS caps a canvas at 16.7 MP; leave room for the frame canvases

/** Width the content is built at for a ratio (the frame minus its side margins). */
export const contentWidth = (ratio: Ratio) => Math.round(FRAME[ratio].w * (1 - MARGIN * 2));

// ---------------------------------------------------------------- sentences

type Seg = { index: number; segment: string };
function sentenceSpans(text: string): Array<{ a: number; b: number }> {
  let segs: Seg[];
  const S = (Intl as unknown as { Segmenter?: new (l: string, o: object) => { segment: (t: string) => Iterable<Seg> } })
    .Segmenter;
  if (S) segs = [...new S('en', { granularity: 'sentence' }).segment(text)];
  else {
    segs = [];
    const re = /[^.!?]+(?:[.!?]+["”’)\]]*|$)\s*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) && m[0]) segs.push({ index: m.index, segment: m[0] });
  }
  const out: Array<{ a: number; b: number }> = [];
  for (const s of segs) {
    let a = s.index;
    let b = s.index + s.segment.length;
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (b - a > 1) out.push({ a, b });
  }
  return out;
}

const LIST = /^(\d{1,3}[.)]|[•●▪◦‣*–-])\s+/;

/** Body lines grouped into paragraphs (headings and list items on their own), as in text.ts. */
function paragraphsOf(lines: Array<{ line: Line; layout: PageLayout; page: number }>) {
  const paras: Array<typeof lines> = [];
  let prev: (typeof lines)[number] | null = null;
  for (const cur of lines) {
    const { line, layout } = cur;
    const heading = line.size > layout.bodySize * 1.15;
    const indent = line.x0 - layout.left > (layout.bodySize * 0.8) / layout.width;
    let fresh = !prev || heading || LIST.test(line.text) || prev.line.size > prev.layout.bodySize * 1.15;
    if (!fresh && prev) {
      fresh =
        prev.page === cur.page
          ? line.baseline - prev.line.baseline > layout.pitch * 1.3 || indent
          : ENDS_SENTENCE.test(prev.line.text) && indent;
    }
    if (fresh) paras.push([cur]);
    else paras[paras.length - 1].push(cur);
    prev = cur;
  }
  return paras;
}

// ---------------------------------------------------------------- Original

export async function originalContent(
  doc: PDFDocumentProxy,
  range: ClipRange,
  theme: ReaderTheme,
  width: number,
): Promise<Content> {
  const trims = await trimSlices(doc, range);
  if (!trims.length) throw new Error('Nothing to export: the clip is empty.');
  const left = Math.min(...trims.map((t) => t.left));
  const right = Math.max(...trims.map((t) => t.right));
  const ptW = trims[0].layout.width;
  const textPt = (right - left) * ptW;
  const gapsPt = trims.slice(1).map((t, i) => gapBetween(trims[i], t));
  // blank bands inside a page (a cleared figure, a section break) close up to a short gap
  const closed = (t: Trim) => t.layout.pitch * 1.6;
  const removed = (t: Trim) => t.holes.reduce((s, h) => s + Math.max(0, h.bottom - h.top - closed(t)), 0);
  const heightPt =
    trims.reduce((s, t) => s + (t.bottom - t.top - removed(t)) * t.layout.height, 0) + gapsPt.reduce((s, g) => s + g, 0);
  const scale = Math.min(width / textPt, Math.sqrt(MAX_PIXELS / (textPt * heightPt)));

  const out = document.createElement('canvas');
  out.width = Math.round(textPt * scale);
  out.height = Math.max(1, Math.round(heightPt * scale));
  const ctx = out.getContext('2d')!;
  const bg = PAGE_BG[theme];
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, out.width, out.height);

  const breaks: Content['breaks'] = [];
  const placed: Array<{ line: Line; layout: PageLayout; page: number; map: (x: number, y: number) => [number, number] }> = [];
  let y = 0;
  for (let i = 0; i < trims.length; i++) {
    const t = trims[i];
    const r = await render(doc, t.page, scale);
    blankFurniture(r.canvas, t.layout);
    // each page is tinted on its own so its photos can be kept (see tint.ts)
    const imgs = isInverted(theme) ? toCanvasSpace(await pageImageMatrices(r.page, r.task), r.transform) : [];
    const page = tintCanvas(r.canvas, theme, imgs);
    const pw = page.width;
    const ph = page.height;
    const sw = (right - left) * pw;
    // the slice as kept bands, each hole shortened to `closed`
    const cut = t.holes.map((h) => ({ ...h, drop: Math.max(0, h.bottom - h.top - closed(t)) }));
    const oy = y;
    const map = (fx: number, fy: number): [number, number] => {
      let d = 0;
      for (const h of cut) {
        if (fy >= h.bottom) d += h.drop;
        else if (fy > h.top) d += Math.min(h.drop, Math.max(0, fy - h.top - (h.bottom - h.top - h.drop) / 2)); // the middle folds away
      }
      return [(fx - left) * pw, oy + (fy - t.top - d) * ph];
    };
    const edges = [
      t.top,
      ...cut.flatMap((h) => [h.top + (h.bottom - h.top - h.drop) / 2, h.bottom - (h.bottom - h.top - h.drop) / 2]),
      t.bottom,
    ];
    for (let k = 0; k < edges.length; k += 2) {
      const a = edges[k];
      const b = edges[k + 1];
      if (b <= a) continue;
      ctx.drawImage(page, left * pw, a * ph, sw, (b - a) * ph, 0, map(0, a)[1], sw, (b - a) * ph);
    }
    for (const h of cut) if (h.drop) breaks.push({ y: map(0, (h.top + h.bottom) / 2)[1], strength: 2 });
    page.width = 0;
    const sh = map(0, t.bottom)[1] - oy;
    const b = boundaries(t.layout);
    const para = new Set(b.paragraphs);
    for (const v of b.lines) if (v > t.top && v < t.bottom) breaks.push({ y: map(0, v)[1], strength: para.has(v) ? 2 : 1 });
    for (const line of t.layout.lines) {
      const mid = (line.top + line.bottom) / 2;
      if (mid >= t.top && mid <= t.bottom) placed.push({ line, layout: t.layout, page: t.page, map });
    }
    y += sh;
    if (i < gapsPt.length) {
      const g = gapsPt[i] * scale;
      breaks.push({ y: y + g / 2, strength: g > t.layout.pitch * t.layout.height * scale * 0.9 ? 2 : 1 });
      y += g;
    }
  }

  // sentences, segmented per paragraph so a heading never runs into the text below it
  const sentences: Sentence[] = [];
  for (const para of paragraphsOf(placed.map(({ line, layout, page }) => ({ line, layout, page })))) {
    const items = para.map((p) => placed.find((q) => q.line === p.line)!);
    let text = '';
    const at: Array<{ k: number; c: number } | null> = [];
    items.forEach((it, k) => {
      if (k) {
        const prevText = items[k - 1].line.text;
        if (!(/\p{Ll}-$/u.test(prevText) && /^\p{Ll}/u.test(it.line.text))) {
          text += ' ';
          at.push(null);
        }
      }
      for (let c = 0; c < it.line.text.length; c++) at.push({ k, c });
      text += it.line.text;
    });
    for (const { a, b } of sentenceSpans(text)) {
      const perLine = new Map<number, { c0: number; c1: number }>();
      for (let i = a; i < b; i++) {
        const p = at[i];
        if (!p) continue;
        const e = perLine.get(p.k);
        if (e) e.c1 = p.c;
        else perLine.set(p.k, { c0: p.c, c1: p.c });
      }
      const rects: Rect[] = [];
      for (const [k, { c0, c1 }] of perLine) {
        const { line, map } = items[k];
        const [x0, y0] = map(line.xs[c0], line.top);
        const [x1, y1] = map(line.xs[c1 + 1] ?? line.x1, line.bottom);
        rects.push({ x: x0, y: y0, w: Math.max(1, x1 - x0), h: y1 - y0 });
      }
      if (rects.length) sentences.push({ id: sentences.length, text: text.slice(a, b), rects });
    }
  }
  return { canvas: out, bg, theme, style: 'original', breaks, sentences };
}

// ---------------------------------------------------------------- Editorial

export const CARD_BG: Record<ReaderTheme, string> = {
  light: '#f8f3ea', // warm paper
  sepia: '#efe2c6',
  dark: '#1c1b1a',
  black: '#000000',
};
const CARD_INK: Record<ReaderTheme, string> = { light: '#1c1917', sepia: '#3a2e1c', dark: '#e7e5e4', black: '#ececec' };
const CARD_ACCENT: Record<ReaderTheme, string> = { light: '#a1561c', sepia: '#8a5a24', dark: '#d9a45f', black: '#d9a45f' };
export const SERIF = "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, 'Times New Roman', serif";

interface Word {
  text: string;
  bold: boolean;
  italic: boolean;
  /** Character offset of the word in the block's plain text. */
  at: number;
  /** Continues the previous word with no space (emphasis inside a word). */
  glue?: boolean;
}

/** Markdown inline emphasis (*, **, ***) into styled words. */
function words(md: string): { plain: string; words: Word[] } {
  const out: Word[] = [];
  let plain = '';
  const re = /(\*{1,3})([^*]+)\1|([^*]+)|(\*+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    const stars = m[1]?.length ?? 0;
    const chunk = m[2] ?? m[3] ?? m[4] ?? '';
    const bold = stars >= 2;
    const italic = stars === 1 || stars === 3;
    const parts = chunk.split(/(\s+)/);
    for (const part of parts) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        plain += ' ';
        continue;
      }
      const glue = !!out.length && !!plain && !plain.endsWith(' ');
      out.push({ text: part, bold, italic, at: plain.length, glue });
      plain += part;
    }
  }
  return { plain, words: out };
}

interface LaidWord {
  x: number;
  w: number;
  word: Word;
  font: string;
  color: string;
  sentence: number;
}
interface LaidLine {
  y: number; // baseline
  top: number;
  bottom: number;
  words: LaidWord[];
}

/** The passage re-set as a typeset card: serif body, a heading, hanging list numbers. */
export function editorialContent(blocks: Block[], theme: ReaderTheme, width: number): Content {
  if (!blocks.length) throw new Error('No text in this clip to typeset. Try Original.');
  const measure = document.createElement('canvas').getContext('2d')!;
  const lay = (f: number) => {
    const body = Math.round(width * 0.042 * f);
    const lead = body * 1.52;
    const lines: LaidLine[] = [];
    const breaks: Content['breaks'] = [];
    const sentences: Array<{ text: string }> = [];
    let y = 0;
    let prevKind: Block['kind'] | null = null;
    for (const b of blocks) {
      const heading = b.kind === 'heading';
      const size = heading ? Math.round(body * 1.32) : body;
      const lh = heading ? size * 1.28 : lead;
      if (prevKind) {
        const gap = heading
          ? body * 1.5
          : prevKind === 'heading'
            ? body * 0.7
            : b.kind === 'item' && prevKind === 'item'
              ? body * 0.45
              : body * 0.9;
        breaks.push({ y: y + gap / 2, strength: 2 });
        y += gap;
      }
      prevKind = b.kind;
      let md = b.md;
      let hang = 0;
      let marker = '';
      if (b.kind === 'item') {
        const m = LIST.exec(b.plain);
        if (m) {
          marker = /\d/.test(m[1]) ? m[1].replace(')', '.') : '•';
          md = md.replace(LIST, '');
          hang = body * 1.7;
        }
      }
      const { plain, words: ws } = words(md);
      const spans = sentenceSpans(plain);
      const base = sentences.length;
      spans.forEach((s) => sentences.push({ text: plain.slice(s.a, s.b) }));
      const sentenceOf = (at: number) => {
        const i = spans.findIndex((s) => at >= s.a && at < s.b);
        return i < 0 ? -1 : base + i;
      };
      const fontOf = (w: Word) => `${w.italic || heading ? 'italic ' : ''}${w.bold || heading ? '600 ' : ''}${size}px ${SERIF}`;
      const ink = heading ? CARD_ACCENT[theme] : CARD_INK[theme];
      measure.font = `${size}px ${SERIF}`;
      const space = measure.measureText(' ').width;
      const maxW = width - hang;
      const startLine = lines.length;
      let cur: LaidWord[] = [];
      let x = 0;
      const flush = () => {
        if (lines.length > startLine) breaks.push({ y, strength: 1 });
        lines.push({ y: y + lh * 0.78, top: y + lh * 0.12, bottom: y + lh * 0.98, words: cur });
        y += lh;
        cur = [];
        x = 0;
      };
      for (const w of ws) {
        measure.font = fontOf(w);
        const ww = measure.measureText(w.text).width;
        if (cur.length && !w.glue && x + space + ww > maxW) flush();
        const g = cur.length && !w.glue ? space : 0;
        cur.push({ x: hang + x + g, w: ww, word: w, font: fontOf(w), color: ink, sentence: sentenceOf(w.at) });
        x += g + ww;
      }
      if (cur.length) flush();
      if (marker && lines[startLine]) {
        const font = `600 ${body}px ${SERIF}`;
        measure.font = font;
        lines[startLine].words.unshift({
          x: 0,
          w: measure.measureText(marker).width,
          word: { text: marker, bold: true, italic: false, at: -1 },
          font,
          color: CARD_ACCENT[theme],
          sentence: -1,
        });
      }
    }
    return { lines, breaks, sentences, height: Math.ceil(y + body * 0.3) };
  };

  let l = lay(1);
  if (width * l.height > MAX_PIXELS) l = lay(Math.sqrt(MAX_PIXELS / (width * l.height)));
  const out = document.createElement('canvas');
  out.width = width;
  out.height = Math.max(1, l.height);
  const ctx = out.getContext('2d')!;
  const bg = CARD_BG[theme];
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.textBaseline = 'alphabetic';
  const rects = new Map<number, Rect[]>();
  for (const line of l.lines) {
    const per = new Map<number, { x0: number; x1: number }>();
    for (const w of line.words) {
      ctx.font = w.font;
      ctx.fillStyle = w.color;
      ctx.fillText(w.word.text, w.x, line.y);
      if (w.sentence < 0) continue;
      const e = per.get(w.sentence);
      if (e) e.x1 = w.x + w.w;
      else per.set(w.sentence, { x0: w.x, x1: w.x + w.w });
    }
    for (const [id, { x0, x1 }] of per) {
      const list = rects.get(id) ?? [];
      list.push({ x: x0, y: line.top, w: x1 - x0, h: line.bottom - line.top });
      rects.set(id, list);
    }
  }
  const sentences: Sentence[] = l.sentences.map((s, id) => ({ id, text: s.text, rects: rects.get(id) ?? [] }));
  return { canvas: out, bg, theme, style: 'editorial', breaks: l.breaks, sentences };
}

// ---------------------------------------------------------------- frames

const FOOTER_RULE: Record<ReaderTheme, string> = { light: '#e7e2da', sepia: '#d9ccb0', dark: '#3a3a3a', black: '#262626' };
const FOOTER_INK: Record<ReaderTheme, string> = { light: '#78716c', sepia: '#7a6a50', dark: '#a8a29e', black: '#a3a3a3' };

export interface FrameOptions {
  ratio: Ratio;
  /** Attribution text for the footer, or null for none. */
  footer: string | null;
  highlights: ReadonlySet<number>;
  mark: Mark;
}

export interface Slide {
  canvas: HTMLCanvasElement;
  /** Sentence boxes on this slide, in its pixels, for tap-to-highlight. */
  hits: Array<{ id: number } & Rect>;
}

/** Where to cut the content into pages of at most `room` px, preferring paragraph breaks. */
export function splitPoints(height: number, room: number, breaks: Content['breaks']): number[] {
  const cuts = [0];
  let pos = 0;
  while (height - pos > room) {
    const window = breaks.filter((b) => b.y > pos + room * 0.4 && b.y <= pos + room);
    const para = window.filter((b) => b.strength === 2);
    const pick = (para.length ? para : window).at(-1)?.y ?? pos + room;
    cuts.push(pick);
    pos = pick;
  }
  cuts.push(height);
  return cuts;
}

function paintHighlight(ctx: CanvasRenderingContext2D, theme: ReaderTheme, mark: Mark, r: Rect, pad: number) {
  const dark = isInverted(theme);
  ctx.save();
  ctx.globalCompositeOperation = dark ? 'screen' : 'multiply';
  ctx.fillStyle = dark
    ? mark === 'amber'
      ? 'rgb(255 176 64 / 0.34)'
      : 'rgb(255 255 255 / 0.2)'
    : mark === 'amber'
      ? '#ffdf86'
      : '#e4e1dc';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(r.x - pad, r.y - pad * 0.4, r.w + pad * 2, r.h + pad * 0.8, pad);
  else ctx.rect(r.x - pad, r.y - pad * 0.4, r.w + pad * 2, r.h + pad * 0.8); // iOS before 16
  ctx.fill();
  ctx.restore();
}

/** The content laid onto output images: even margins, footer, ratio, highlights, slide numbers. */
export function frames(content: Content, opts: FrameOptions): Slide[] {
  const { w: W, h: fixedH } = FRAME[opts.ratio];
  const c = content.canvas;
  const m = Math.round(W * MARGIN);
  const fontPx = Math.round(W * 0.019);
  const footerH = opts.footer ? Math.round(fontPx * 3) : 0;
  const vm = opts.ratio === '9:16' ? Math.round(fixedH * STORY_SAFE) : m;
  const room = fixedH ? fixedH - vm * 2 - footerH : Infinity;

  // fit the width; for a carousel, shrink a little if that keeps it within MAX_SLIDES
  let f = Math.min(1, (W - m * 2) / c.width);
  let cuts = Number.isFinite(room) ? splitPoints(c.height, room / f, content.breaks) : [0, c.height];
  while (cuts.length - 1 > MAX_SLIDES && f > 0.55) {
    f *= 0.9;
    cuts = splitPoints(c.height, room / f, content.breaks);
  }
  if (cuts.length - 1 > MAX_SLIDES) {
    f = Math.min(f, (room * MAX_SLIDES) / c.height);
    cuts = splitPoints(c.height, room / f, content.breaks);
  }
  const n = cuts.length - 1;
  const cw = c.width * f;
  const x0 = (W - cw) / 2;
  const slides: Slide[] = [];
  for (let i = 0; i < n; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    const sh = (b - a) * f;
    const H = fixedH || Math.round(sh + m * 2 + footerH);
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = content.bg;
    ctx.fillRect(0, 0, W, H);
    // a single frame is centred in its space; a carousel's frames all start at the same height
    const y0 = fixedH && n === 1 ? vm + (room - sh) / 2 : vm;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(c, 0, a, c.width, b - a, x0, y0, cw, sh);
    const hits: Slide['hits'] = [];
    for (const s of content.sentences) {
      for (const r of s.rects) {
        const mid = r.y + r.h / 2;
        if (mid < a || mid >= b) continue;
        const rr = { x: x0 + r.x * f, y: y0 + (r.y - a) * f, w: r.w * f, h: r.h * f };
        hits.push({ id: s.id, ...rr });
        if (opts.highlights.has(s.id)) paintHighlight(ctx, content.theme, opts.mark, rr, rr.h * 0.14);
      }
    }
    if (opts.footer || n > 1) {
      const fy = H - (fixedH ? vm : m) - footerH + fontPx * 0.6;
      const ink = FOOTER_INK[content.theme];
      ctx.font = `${content.style === 'editorial' ? 'italic ' : ''}${fontPx}px ${SERIF}`;
      ctx.textBaseline = 'middle';
      const counter = n > 1 ? `${i + 1}/${n}` : '';
      const counterW = counter ? ctx.measureText(counter).width + fontPx : 0;
      if (opts.footer) {
        ctx.fillStyle = FOOTER_RULE[content.theme];
        ctx.fillRect(m, fy, W - m * 2, Math.max(1, Math.round(W / 1000)));
        ctx.fillStyle = ink;
        let text = opts.footer;
        const maxW = W - m * 2 - counterW;
        while (ctx.measureText(text).width > maxW && text.length > 8) text = `${text.slice(0, -2).trimEnd()}…`;
        ctx.fillText(text, m, fy + footerH / 2);
      }
      if (counter) {
        ctx.fillStyle = ink;
        ctx.textAlign = 'right';
        ctx.fillText(counter, W - m, opts.footer ? fy + footerH / 2 : H - m / 2);
        ctx.textAlign = 'left';
      }
    }
    slides.push({ canvas: out, hits });
  }
  return slides;
}

export async function slideBlobs(slides: Slide[]): Promise<Blob[]> {
  const out: Blob[] = [];
  for (const s of slides) {
    const blob = await new Promise<Blob | null>((res) => s.canvas.toBlob(res, 'image/png'));
    s.canvas.width = 0;
    if (!blob) throw new Error("Couldn't create the image.");
    out.push(blob);
  }
  return out;
}
