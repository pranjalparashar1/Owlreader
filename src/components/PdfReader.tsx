import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { pdfjs, type PDFDocumentProxy } from '../lib/pdfjs';
import { pageTextFromItems } from '../lib/terms';
import type { ReaderTheme } from '../types';
import { PAGE_BG, isInverted, tintCanvas } from '../lib/tint';
import { pageImageMatrices, toCanvasSpace } from '../lib/pageImages';
import { PreviewCache, encodePreview } from '../lib/previews';
import { tapZone, type OutlineItem, type ReaderHandle, type ReaderProps } from './readerTypes';
import { prefersReducedMotion } from '../hooks/useFocusTrap';

/** Zoom is a multiplier of fit-width. The default zoom (fit text) is also the furthest out. */
const MAX_ZOOM = 4;
const MAX_OVER_DEFAULT = 2.5; // a big default (narrow text column) can still zoom this far past it
const ZOOM_STEP = 1.25;
const ZOOM_ANIM_MS = 280; // zoom buttons and the pinch's spring back, on the compositor
const PAD = 8; // breathing room around a page at fit-width (inside the safe area)
const GAP = 10; // between pages in Scroll mode (matches .pdf-scrolled .pdf-page margin)
/** First pass: fast to draw and cheap to upload to the GPU while the reader is moving. */
const FIRST_PASS_PIXELS = 2_200_000;
const FIRST_PASS_MAX_DPR = 2;
/** Crispness pass for the current page only, once the reader has settled on it. */
const SHARP_PASS_PIXELS = 4_500_000;
const SCROLL_IDLE_MS = 140;
const QUIET_MS = 300; // idle time before the sharp pass and page-size probing run
const PROBE_WINDOW = 20; // real page sizes are fetched for current ± this many pages
const PROBE_BATCH = 4;
const MOUNT_AROUND = 8; // Scroll mode keeps current ± this many page boxes in the DOM
const MOUNT_LEAD = 3; // while scrolling, the mounted window is centred this many pages ahead
const THUMB_CACHE = 48; // scrubber micro-thumbnails kept (≈0.04 MP each, ~7 MB worst case)
/** Previews: small JPEGs of each page, painted as the page box's background the moment it
 * appears, so a fling shows real (soft) pages instead of blank ones until the canvas lands. */
const PREVIEW_W = 240; // px wide: ≈ 15–30 KB as JPEG, ~3–8 ms to render on a recent iPhone
const PREVIEW_CACHE = 320; // ≈ 5–9 MB of blobs worst case
const PREVIEW_AHEAD = 40; // idle prefetch covers this many pages in the reading direction…
const PREVIEW_BEHIND = 15; // …and this many behind
const PREVIEW_BATCH = 1; // per idle task, so a touch never waits long on the main thread

/** Fit text: the text column fills the safe area (clear of the Dynamic Island and the rounded
 * corners in landscape), with this much space each side (CSS px). */
const FIT_MARGIN = 14;
const FIT_MAX = 2.5;
const FIT_SAMPLE = 6; // pages read to find the text column
/** Past the zoom limits a pinch keeps moving, ever more slowly, then springs back (like iOS). */
const rubberBand = (s: number, lo: number, hi: number) => (s < lo ? lo * (s / lo) ** 0.35 : s > hi ? hi * (s / hi) ** 0.35 : s);

type TextBox = { x0: number; x1: number };

/** The text column across a few pages, as fractions of page width (2nd–98th percentile of
 * line starts and ends, so a stray page number or marginal note doesn't widen it). */
async function findTextBox(doc: PDFDocumentProxy, from: number): Promise<TextBox | null> {
  const lefts: number[] = [];
  const rights: number[] = [];
  for (let n = from; n < from + FIT_SAMPLE && n <= doc.numPages; n++) {
    const p = await doc.getPage(n);
    const vp = p.getViewport({ scale: 1 });
    const content = await p.getTextContent();
    for (const it of content.items) {
      if (!('str' in it) || !it.str.trim() || !it.width) continue;
      const [a, b, , , e, f] = it.transform as number[];
      if (Math.abs(b) > 0.01 || a <= 0) continue; // rotated text
      const [l] = vp.convertToViewportPoint(e, f);
      const [r] = vp.convertToViewportPoint(e + it.width, f);
      lefts.push(Math.min(l, r) / vp.width);
      rights.push(Math.max(l, r) / vp.width);
    }
  }
  if (lefts.length < 8) return null;
  lefts.sort((x, y) => x - y);
  rights.sort((x, y) => x - y);
  const x0 = Math.max(0, lefts[Math.floor(lefts.length * 0.02)]);
  const x1 = Math.min(1, rights[Math.ceil(rights.length * 0.98) - 1]);
  return x1 - x0 > 0.3 ? { x0, x1 } : null;
}

/** Flattens the PDF outline to the chapters a reader would pick from (two levels deep). */
async function readOutline(doc: PDFDocumentProxy): Promise<OutlineItem[]> {
  const outline = await doc.getOutline().catch(() => null);
  if (!outline?.length) return [];
  const out: OutlineItem[] = [];
  const walk = async (items: typeof outline, depth: number) => {
    for (const it of items) {
      let page = 0;
      try {
        const dest = typeof it.dest === 'string' ? await doc.getDestination(it.dest) : it.dest;
        const ref = dest?.[0];
        if (ref && typeof ref === 'object') page = (await doc.getPageIndex(ref)) + 1;
        else if (typeof ref === 'number') page = ref + 1;
      } catch {
        /* unresolvable entry */
      }
      const title = it.title?.trim();
      if (page && title) out.push({ title, page, depth });
      if (depth < 1 && it.items?.length) await walk(it.items, depth + 1);
    }
  };
  await walk(outline, 0);
  return out;
}

/** Renders one page into a fresh canvas with the theme baked in (see tint.ts). */
async function drawPage(
  doc: PDFDocumentProxy,
  num: number,
  scale: number,
  ratio: number,
  theme: ReaderTheme,
  onTask?: (t: { cancel(): void }) => void,
  isCancelled: () => boolean = () => false,
): Promise<HTMLCanvasElement | null> {
  const p = await doc.getPage(num);
  if (isCancelled()) return null;
  const viewport = p.getViewport({ scale });
  let canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  const task = p.render({
    canvas,
    viewport,
    transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
    background: '#ffffff',
  });
  onTask?.(task);
  try {
    await task.promise;
  } catch {
    canvas.width = 0;
    return null;
  }
  if (isCancelled()) {
    canvas.width = 0;
    return null;
  }
  // dark/black: find the page's photos so they keep their colours (see tint.ts)
  const imgs = isInverted(theme) ? toCanvasSpace(await pageImageMatrices(p, task), viewport.transform, ratio) : [];
  if (isCancelled()) {
    canvas.width = 0;
    return null;
  }
  canvas = tintCanvas(canvas, theme, imgs);
  canvas.className = 'pdf-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  return canvas;
}

/** First-pass resolution for a page box (capped at 2x DPR / 2.2 MP). */
const firstPassRatio = (baseW: number, baseH: number, scale: number) =>
  Math.min(window.devicePixelRatio || 1, FIRST_PASS_MAX_DPR, Math.sqrt(FIRST_PASS_PIXELS / (baseW * scale * baseH * scale)));
const canvasKey = (scale: number, theme: ReaderTheme) => `${scale.toFixed(4)}|${window.devicePixelRatio || 1}|${theme}`;

type Size = { w: number; h: number };
type Task = () => Promise<void>;

/** Main-queue bias, added to a task's distance from the current page (lower runs first):
 * text layers go after the canvases of the pages around it, so a landing paints them first. */
const BIAS_CANVAS = 0;
const BIAS_TEXT = 1.5;

/**
 * One pdf.js job at a time, and never while the user is scrolling: pdf.js draws on the main
 * thread, so rendering mid-gesture is what makes native scrolling stutter on iPhone.
 * - `request`: first-pass canvases and text layers, nearest-to-current page first.
 * - `requestIdle`: sharp passes and page-size probes. They run only when nothing else is queued
 *   and the reader has been still for QUIET_MS, lowest `prio` first.
 */
class RenderScheduler {
  private queue = new Map<string, { page: number; bias: number; task: Task }>();
  private idle = new Map<string, { prio: number; task: Task }>();
  private running = false;
  private timer: number | undefined;
  private quietSince = performance.now();
  private _scrolling = false;
  /** A pinch or zoom animation is running: nothing renders until it ends (see pump). */
  private _held = false;
  current = 1;
  /** Way the reader is moving: of two pages equally near, the one ahead goes first. */
  dir = 1;
  private soon = false;
  get scrolling() {
    return this._scrolling;
  }
  set scrolling(v: boolean) {
    this._scrolling = v;
    if (!v) this.quietSince = performance.now();
  }
  set held(v: boolean) {
    this._held = v;
    if (v) return;
    this.quietSince = performance.now();
    this.pump();
  }
  request(key: string, page: number, bias: number, task: Task) {
    this.queue.set(key, { page, bias, task });
    // pump once the whole commit has queued its work, not on the first page's effect
    if (this.soon) return;
    this.soon = true;
    queueMicrotask(() => {
      this.soon = false;
      this.pump();
    });
  }
  cancel(key: string) {
    this.queue.delete(key);
  }
  /** Drops queued work for pages outside [lo, hi] (the reader moved on). Their components
   * cancel it too, but only after React commits, and settle pumps before that. */
  dropOutside(lo: number, hi: number) {
    for (const [k, v] of this.queue) if (v.page < lo || v.page > hi) this.queue.delete(k);
  }
  requestIdle(key: string, prio: number, task: Task) {
    this.idle.set(key, { prio, task });
    this.pump();
  }
  cancelIdle(key: string) {
    this.idle.delete(key);
  }
  pump = () => {
    window.clearTimeout(this.timer);
    if (this.running || this._scrolling || this._held) return;
    let task: Task | undefined;
    if (this.queue.size) {
      let bestKey = '';
      let best = Infinity;
      for (const [k, v] of this.queue) {
        const d = v.page - this.current;
        const cost = Math.abs(d) + v.bias + (d * this.dir < 0 ? 0.25 : 0);
        if (cost < best) [bestKey, best] = [k, cost];
      }
      task = this.queue.get(bestKey)!.task;
      this.queue.delete(bestKey);
    } else if (this.idle.size) {
      const wait = QUIET_MS - (performance.now() - this.quietSince);
      if (wait > 0) {
        this.timer = window.setTimeout(this.pump, wait + 5);
        return;
      }
      let bestKey = '';
      let bestPrio = Infinity;
      for (const [k, v] of this.idle) if (v.prio < bestPrio) [bestKey, bestPrio] = [k, v.prio];
      task = this.idle.get(bestKey)!.task;
      this.idle.delete(bestKey);
    }
    if (!task) return;
    this.running = true;
    task()
      .catch(() => {})
      .finally(() => {
        this.running = false;
        // yield a frame so input/scroll handling gets in between renders
        requestAnimationFrame(this.pump);
      });
  };
}

interface Props extends ReaderProps {
  flow: 'paginated' | 'scrolled';
}

/**
 * PDF reader built on the browser's own scrolling so iOS does the work on the compositor:
 * - Pages mode: a horizontal CSS scroll-snap carousel (native swipe, momentum and snap).
 * - Scroll mode: one vertical column of pages with native momentum scrolling.
 * Only nearby pages hold a canvas, and in Scroll mode only ~17 page boxes exist at all (spacers
 * stand in for the rest). Each live page has a canvas (a fast first pass, then a sharp pass for
 * the current page once the reader settles) and PDF.js's TextLayer on top for native selection.
 * Page sizes are fetched lazily around the current page instead of for the whole document.
 * Zoom is a multiplier of fit-to-width, so rotating keeps the same page and relative zoom. Every
 * book opens at the default zoom (fit text, inside the safe area), and that's also the furthest out.
 */
// memo: the shell re-renders on every chrome toggle and selection change; the reader needn't.
const PdfReader = memo(
  forwardRef<ReaderHandle, Props>(function PdfReader(props, ref) {
    const { book, data, theme, flow } = props;
    const paged = flow === 'paginated';
    const propsRef = useRef(props);
    propsRef.current = props;

    const scrollerRef = useRef<HTMLDivElement>(null);
    const slotRefs = useRef<Array<HTMLDivElement | null>>([]);
    const pageRefs = useRef<Array<HTMLDivElement | null>>([]);
    const trackRef = useRef<HTMLDivElement>(null);
    const scheduler = useMemo(() => new RenderScheduler(), []);

    const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
    const [sizes, setSizes] = useState<Size[]>([]);
    const [page, setPage] = useState(() => Math.max(1, book.progress.pdfPage ?? 1));
    const [manualZoom, setManualZoom] = useState(1);
    /** At the default zoom (fit text): zoom follows the text column, in either orientation. A
     * saved zoom is never restored: every open starts here. */
    const [autoFit, setAutoFit] = useState(true);
    const [textBox, setTextBox] = useState<TextBox | null>(null);
    const [outline, setOutline] = useState<OutlineItem[] | null>(null);
    const [viewport, setViewport] = useState<Size>({ w: 0, h: 0 });
    /** Safe-area insets left and right (the Dynamic Island side in landscape), from CSS env(). */
    const [insets, setInsets] = useState({ l: 0, r: 0 });
    const insetProbe = useRef<HTMLDivElement>(null);
    const [range, setRange] = useState<[number, number]>([page - 1, page + 1]);

    const numPages = sizes.length;
    const pageRef = useRef(page);
    pageRef.current = page;
    scheduler.current = page;
    /** Scroll mode: the page the mounted window is centred on. Follows the scroll position while
     * scrolling (cheap, no pdf.js work) so a fling never runs past the mounted boxes. */
    const [mountAt, setMountAt] = useState(page);
    const mountAtRef = useRef(mountAt);
    mountAtRef.current = mountAt;
    /** Direction of the last scroll (+1 forward, -1 back): lookahead and prefetch lean that way. */
    const dirRef = useRef(1);
    const lastPosRef = useRef(0);

    /** Where to put the reader back after a layout change: page + fraction scrolled into it. */
    const anchor = useRef({ page, frac: 0 });
    const needsRestore = useRef(true);
    // switching Pages <-> Scroll rebuilds the layout: restore before anything re-reads the position
    const lastFlow = useRef(flow);
    if (lastFlow.current !== flow) {
      lastFlow.current = flow;
      needsRestore.current = true;
      anchor.current = { page, frac: 0 };
    }
    const zoomFocal = useRef<{ fx: number; fy: number; mx: number; my: number; page: number } | null>(null);

    // ---- lazy page sizes. Real sizes arrive from the probe or from a page's own render; they're
    // applied in one batch while the reader is still, and the restore effect then puts the anchor
    // page back exactly where it was, so a page above changing height never moves the text you read.
    const sizesRef = useRef(sizes);
    sizesRef.current = sizes;
    const probed = useRef(new Set<number>());
    const pendingSizes = useRef(new Map<number, Size>());
    const flushSizes = useCallback(() => {
      if (scheduler.scrolling || pendingSizes.current.size === 0) return;
      const updates = [...pendingSizes.current];
      pendingSizes.current.clear();
      needsRestore.current = true;
      setSizes((prev) => {
        const next = prev.slice();
        for (const [num, sz] of updates) if (next[num - 1]) next[num - 1] = sz;
        return next;
      });
    }, [scheduler]);
    const reportSize = useCallback(
      (num: number, w: number, h: number) => {
        probed.current.add(num);
        const cur = sizesRef.current[num - 1];
        if (!cur || (Math.abs(cur.w - w) <= 1 && Math.abs(cur.h - h) <= 1)) return;
        pendingSizes.current.set(num, { w, h });
        flushSizes();
      },
      [flushSizes],
    );

    // ---- load document + page sizes
    useEffect(() => {
      let cancelled = false;
      let loaded: PDFDocumentProxy | null = null;
      const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) });
      task.promise.then(
        async (d) => {
          if (cancelled) return void d.destroy();
          loaded = d;
          const start = Math.min(Math.max(1, pageRef.current), d.numPages);
          // Only page 1 and the start page are measured up front. Every other page assumes page 1's
          // size until the lazy probe (or its own render) reports the real one.
          const first = (await d.getPage(1)).getViewport({ scale: 1 });
          const startVp = start === 1 ? first : (await d.getPage(start)).getViewport({ scale: 1 });
          if (cancelled) return;
          const initial = Array.from({ length: d.numPages }, () => ({ w: first.width, h: first.height }));
          initial[start - 1] = { w: startVp.width, h: startVp.height };
          probed.current = new Set([1, start]);
          pendingSizes.current.clear();
          anchor.current = { page: start, frac: 0 };
          needsRestore.current = true;
          setPage(start);
          setRange([start - 1, start + 1]);
          setSizes(initial);
          setDoc(d);
          findTextBox(d, Math.max(1, Math.min(start, d.numPages - FIT_SAMPLE + 1)))
            .then((tb) => !cancelled && setTextBox(tb))
            .catch(() => {});
        },
        (err) => {
          console.error(err);
          if (!cancelled) propsRef.current.onError("This PDF couldn't be opened. It may be damaged or password-protected.");
        },
      );
      return () => {
        cancelled = true;
        task.destroy();
        loaded?.destroy();
      };
    }, [data]);

    // ---- viewport size (rotation / resize)
    useEffect(() => {
      const el = scrollerRef.current!;
      const measure = () => {
        const cs = insetProbe.current && getComputedStyle(insetProbe.current);
        const l = cs ? parseFloat(cs.paddingLeft) || 0 : 0;
        const r = cs ? parseFloat(cs.paddingRight) || 0 : 0;
        setInsets((v) => (v.l === l && v.r === r ? v : { l, r }));
        const next = { w: el.clientWidth, h: el.clientHeight };
        setViewport((v) => {
          if (v.w === next.w && v.h === next.h) return v;
          needsRestore.current = true;
          return next;
        });
      };
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      measure();
      // the insets change with rotation, sometimes a beat after the resize
      const mq = matchMedia('(orientation: landscape)');
      mq.addEventListener('change', measure);
      return () => {
        ro.disconnect();
        mq.removeEventListener('change', measure);
      };
    }, []);

    // ---- per-page CSS size
    const safeW = Math.max(100, viewport.w - insets.l - insets.r);
    /** Horizontal centre of the safe area: where the text column sits at the default zoom. */
    const safeMid = insets.l + safeW / 2;
    const availW = Math.max(100, safeW - PAD * 2);
    const fitZoom = useMemo(() => {
      if (!textBox || !viewport.w) return 1;
      const z = (safeW - FIT_MARGIN * 2) / ((textBox.x1 - textBox.x0) * availW);
      return z < 1.02 ? 1 : Math.min(FIT_MAX, z);
    }, [textBox, viewport.w, safeW, availW]);
    const maxZoom = Math.max(MAX_ZOOM, fitZoom * MAX_OVER_DEFAULT);
    const zoom = autoFit ? fitZoom : Math.min(maxZoom, Math.max(fitZoom, manualZoom));
    const atDefault = autoFit || zoom <= fitZoom * 1.001;
    const fitting = atDefault && fitZoom > 1;
    const limitsRef = useRef({ min: fitZoom, max: maxZoom });
    limitsRef.current = { min: fitZoom, max: maxZoom };
    // a zoom that isn't a pinch (fit text arriving, rotating, the Fit button) keeps the reading spot
    const lastZoom = useRef(zoom);
    if (lastZoom.current !== zoom) {
      lastZoom.current = zoom;
      if (!zoomFocal.current) needsRestore.current = true;
    }
    const scaleOf = useCallback((i: number) => (availW / sizes[i].w) * zoom, [availW, sizes, zoom]);
    const cssSize = (i: number) => {
      const s = scaleOf(i);
      return { w: Math.floor(sizes[i].w * s), h: Math.floor(sizes[i].h * s) };
    };
    /** Scroll-mode geometry from sizes alone (no DOM): box heights and each page's top inside the
     * track, not counting the track's top padding. Spacers make the DOM match these exactly. */
    const geo = useMemo(() => {
      const n = sizes.length;
      const heights = new Array<number>(n);
      const tops = new Array<number>(n + 1);
      let maxW = 0;
      tops[0] = 0;
      for (let i = 0; i < n; i++) {
        const s = scaleOf(i);
        heights[i] = Math.floor(sizes[i].h * s);
        maxW = Math.max(maxW, Math.floor(sizes[i].w * s));
        tops[i + 1] = tops[i] + heights[i] + GAP;
      }
      return { heights, tops, maxW };
    }, [sizes, scaleOf]);
    const geoRef = useRef(geo);
    geoRef.current = geo;
    /** The track's top padding (8px + the safe-area inset), read from CSS. */
    const padTop = () => (trackRef.current ? parseFloat(getComputedStyle(trackRef.current).paddingTop) || 0 : 0);

    // ---- which page is current / which pages are near (from scroll position)
    const locate = useCallback(() => {
      const el = scrollerRef.current;
      if (!el || !numPages) return;
      let current: number;
      let frac = 0;
      let lo: number;
      let hi: number;
      if (paged) {
        const w = el.clientWidth || 1;
        const pos = el.scrollLeft / w;
        current = Math.min(numPages, Math.max(1, Math.round(pos) + 1));
        lo = Math.floor(pos);
        hi = Math.ceil(pos) + 2;
        const slot = slotRefs.current[current - 1];
        if (slot && slot.scrollHeight > slot.clientHeight) frac = slot.scrollTop / slot.scrollHeight;
      } else {
        const { tops, heights } = geoRef.current;
        const top = el.scrollTop - padTop();
        const probe = top + el.clientHeight * 0.3;
        // binary search the last page whose top is above the probe line
        let a = 0;
        let b = numPages - 1;
        while (a < b) {
          const m = (a + b + 1) >> 1;
          if (tops[m] <= probe) a = m;
          else b = m - 1;
        }
        current = a + 1;
        frac = (top - tops[a]) / Math.max(1, heights[a]);
        if (Math.abs(el.scrollTop - lastPosRef.current) > 4) dirRef.current = el.scrollTop > lastPosRef.current ? 1 : -1;
        lastPosRef.current = el.scrollTop;
        // visible range plus lookahead, leaning the way the reader last moved: 3 screens ahead, 1 behind
        const above = dirRef.current > 0 ? 1 : 3;
        const below = dirRef.current > 0 ? 3 : 1;
        let first = a;
        while (first > 0 && tops[first] > top - el.clientHeight * above) first--;
        let last = a;
        while (last < numPages - 1 && tops[last + 1] < top + el.clientHeight * below) last++;
        lo = first + 1;
        hi = last + 1;
      }
      if (paged && current !== pageRef.current) dirRef.current = current > pageRef.current ? 1 : -1;
      anchor.current = { page: current, frac };
      // the scheduler must rank by the new page now: settle pumps before React re-renders
      scheduler.current = current;
      scheduler.dir = dirRef.current;
      scheduler.dropOutside(lo, hi);
      if (current !== pageRef.current) setPage(current);
      if (!paged) setMountAt(current);
      setRange((r) => (r[0] === lo && r[1] === hi ? r : [lo, hi]));
    }, [numPages, paged, scheduler]);

    // ---- restore position after anything that changes layout (open, rotate, zoom, flow)
    useLayoutEffect(() => {
      const el = scrollerRef.current;
      if (!el || !numPages || !viewport.w) return;
      const focal = zoomFocal.current;
      zoomFocal.current = null;
      // clear the zoom preview transform in the same frame the real sizes land
      if (el.style.transform) {
        el.style.transition = 'none';
        el.style.transform = '';
      }

      if (focal) {
        const pageEl = pageRefs.current[focal.page - 1];
        const container = paged ? slotRefs.current[focal.page - 1] : el;
        if (pageEl && container) {
          if (paged) el.scrollLeft = (focal.page - 1) * el.clientWidth;
          container.scrollLeft = pageEl.offsetLeft + focal.fx * pageEl.offsetWidth - focal.mx;
          container.scrollTop = pageEl.offsetTop + focal.fy * pageEl.offsetHeight - focal.my;
          needsRestore.current = false;
          locate();
          return;
        }
      }
      if (!needsRestore.current) return;
      needsRestore.current = false;
      const { page: p, frac } = anchor.current;
      if (paged) {
        el.scrollLeft = (p - 1) * el.clientWidth;
        const slot = slotRefs.current[p - 1];
        if (slot) slot.scrollTop = frac * slot.scrollHeight;
      } else {
        const { tops, heights } = geoRef.current;
        el.scrollTop = padTop() + tops[p - 1] + frac * heights[p - 1];
      }
      locate();
    }, [viewport, zoom, sizes, paged, numPages, locate]);

    // ---- scroll handling. While the finger or momentum is moving we do *nothing* but note
    // that we're scrolling: no React state, no DOM changes, no pdf.js work. iOS scrolls on its
    // own thread, but it still needs the main thread free to paint newly exposed content.
    // Position, page label and which pages are live all update once scrolling settles.
    useEffect(() => {
      const el = scrollerRef.current!;
      let idle: number | undefined;
      let frame = 0;
      const settle = () => {
        scheduler.scrolling = false;
        locate();
        flushSizes();
        scheduler.pump();
      };
      // Scroll mode, once a frame at most: keep page boxes mounted under (and ahead of) the
      // viewport. Reads scrollTop and the size table only; boxes show their cached preview.
      let lastTop = el.scrollTop;
      const track = () => {
        frame = 0;
        const n = geoRef.current.tops.length - 1;
        if (paged || !n) return;
        const top = el.scrollTop;
        const dir = top >= lastTop ? 1 : -1;
        lastTop = top;
        const { tops } = geoRef.current;
        const probe = top - padTop() + el.clientHeight * 0.5;
        let a = 0;
        let b = n - 1;
        while (a < b) {
          const m = (a + b + 1) >> 1;
          if (tops[m] <= probe) a = m;
          else b = m - 1;
        }
        const centre = Math.min(n, Math.max(1, a + 1 + dir * MOUNT_LEAD));
        if (Math.abs(centre - mountAtRef.current) >= MOUNT_LEAD) {
          mountAtRef.current = centre;
          setMountAt(centre);
        }
      };
      const onScroll = () => {
        scheduler.scrolling = true;
        window.clearTimeout(idle);
        idle = window.setTimeout(settle, SCROLL_IDLE_MS);
        if (!frame) frame = requestAnimationFrame(track);
      };
      el.addEventListener('scroll', onScroll, { passive: true });
      // in Pages mode the live slots scroll vertically too (tall or zoomed pages)
      el.addEventListener('scroll', onScroll, { passive: true, capture: true });
      return () => {
        el.removeEventListener('scroll', onScroll);
        el.removeEventListener('scroll', onScroll, { capture: true });
        window.clearTimeout(idle);
        cancelAnimationFrame(frame);
      };
    }, [locate, scheduler, flushSizes, paged]);

    // ---- probe real page sizes for current ± PROBE_WINDOW, nearest first, after the current
    // page's canvas and text layer (it's an idle task). Replaces 1.1's loop over every page.
    useEffect(() => {
      if (!doc || !numPages) return;
      let cancelled = false;
      const pending = () => {
        const out: number[] = [];
        for (let d = 0; d <= PROBE_WINDOW; d++) {
          for (const n of d ? [page + d, page - d] : [page]) {
            if (n >= 1 && n <= numPages && !probed.current.has(n)) out.push(n);
          }
        }
        return out;
      };
      const step = async () => {
        for (const n of pending().slice(0, PROBE_BATCH)) {
          if (cancelled) return;
          const v = (await doc.getPage(n)).getViewport({ scale: 1 });
          if (cancelled) return;
          reportSize(n, v.width, v.height);
        }
        if (!cancelled && pending().length) scheduler.requestIdle('probe', 10, step);
      };
      if (pending().length) scheduler.requestIdle('probe', 10, step);
      return () => {
        cancelled = true;
        scheduler.cancelIdle('probe');
      };
    }, [doc, numPages, page, reportSize, scheduler]);

    // ---- report progress through the shell's single funnel
    useEffect(() => {
      if (!numPages) return;
      const fraction = numPages > 1 ? (page - 1) / (numPages - 1) : 1;
      // zoom is shown relative to the default: 100% = fit text
      propsRef.current.onLocation({
        fraction,
        page,
        pageCount: numPages,
        label: `Page ${page} of ${numPages}`,
        zoom: zoom / fitZoom,
      });
      propsRef.current.onProgressChange({ pdfPage: page, percentage: Math.round((page / numPages) * 1000) / 10 });
    }, [page, zoom, fitZoom, numPages]);
    // a page turn hides the chrome (not the first report, and not a zoom)
    const reportedPage = useRef(0);
    useEffect(() => {
      if (!numPages) return;
      if (reportedPage.current && reportedPage.current !== page) propsRef.current.onPageTurn();
      reportedPage.current = page;
    }, [page, numPages]);

    const goToPage = useCallback(
      (n: number, smooth = false, frac = 0) => {
        const el = scrollerRef.current;
        if (!el || !numPages) return;
        const target = Math.min(numPages, Math.max(1, Math.round(n)));
        const behavior: ScrollBehavior =
          smooth && !prefersReducedMotion() && Math.abs(target - pageRef.current) <= 2 ? 'smooth' : 'instant';
        if (paged) el.scrollTo({ left: (target - 1) * el.clientWidth, behavior });
        else
          el.scrollTo({
            top: padTop() + geoRef.current.tops[target - 1] + frac * geoRef.current.heights[target - 1] - PAD,
            behavior,
          });
        if (behavior === 'instant') requestAnimationFrame(locate);
      },
      [numPages, paged, locate],
    );

    const next = useCallback(() => {
      const el = scrollerRef.current;
      if (!paged && el) el.scrollBy({ top: el.clientHeight * 0.85, behavior: prefersReducedMotion() ? 'instant' : 'smooth' });
      else goToPage(pageRef.current + 1, true);
    }, [goToPage, paged]);
    const prev = useCallback(() => {
      const el = scrollerRef.current;
      if (!paged && el) el.scrollBy({ top: -el.clientHeight * 0.85, behavior: prefersReducedMotion() ? 'instant' : 'smooth' });
      else goToPage(pageRef.current - 1, true);
    }, [goToPage, paged]);

    /** Change zoom keeping the point under (mx, my) — viewport coords — fixed on screen. At or
     * below the default zoom it snaps back to the default. */
    const zoomAt = useCallback(
      (nextZoom: number, mx?: number, my?: number) => {
        const el = scrollerRef.current;
        const z = Math.min(maxZoom, nextZoom);
        const toDefault = z <= fitZoom * 1.001;
        if (!el || (toDefault ? autoFit : z === zoom && !autoFit)) return;
        const p = pageRef.current;
        const pageEl = pageRefs.current[p - 1];
        const container = paged ? slotRefs.current[p - 1] : el;
        if (pageEl && container) {
          // the scroller may be scaled by a zoom preview: measure its untransformed parent (same box)
          const rect = el.parentElement!.getBoundingClientRect();
          const cx = (mx ?? rect.left + rect.width / 2) - rect.left;
          const cy = (my ?? rect.top + rect.height / 2) - rect.top;
          zoomFocal.current = {
            page: p,
            mx: cx,
            my: cy,
            fx: (container.scrollLeft + cx - pageEl.offsetLeft) / pageEl.offsetWidth,
            fy: (container.scrollTop + cy - pageEl.offsetTop) / pageEl.offsetHeight,
          };
        }
        setManualZoom(toDefault ? fitZoom : z);
        setAutoFit(toDefault);
      },
      [zoom, paged, autoFit, fitZoom, maxZoom],
    );

    /** The scroller is the one layer scaled while zooming: viewport-sized, so the compositor only
     * scales what's on screen, the same way in Pages and Scroll mode. */
    const zoomAnim = useRef<{ timer: number; done: () => void } | null>(null);
    const setPreview = useCallback((scale: number, ox: number, oy: number, ms = 0) => {
      const el = scrollerRef.current;
      if (!el) return;
      el.style.transformOrigin = `${ox}px ${oy}px`;
      el.style.transition = ms ? `transform ${ms}ms var(--ease-ios)` : 'none';
      el.style.transform = scale === 1 && !ms ? '' : `scale(${scale})`;
    }, []);
    /** Animates the preview to `scale` on the compositor, then calls `done` (once). */
    const animatePreview = useCallback(
      (scale: number, ox: number, oy: number, done: () => void) => {
        zoomAnim.current?.done();
        if (prefersReducedMotion()) return done();
        setPreview(scale, ox, oy, ZOOM_ANIM_MS);
        let fired = false;
        const finish = () => {
          if (fired) return;
          fired = true;
          window.clearTimeout(zoomAnim.current?.timer);
          zoomAnim.current = null;
          done();
        };
        zoomAnim.current = { timer: window.setTimeout(finish, ZOOM_ANIM_MS + 40), done: finish };
      },
      [setPreview],
    );
    /** Zoom buttons: scale the screen to the new zoom around its centre, then lay it out for real.
     * A tap during the animation retargets it, so quick taps add up in one smooth motion. */
    const zoomRef = useRef(zoom);
    zoomRef.current = zoom;
    const stepTarget = useRef<number | null>(null);
    const stepZoom = useCallback(
      (dir: 1 | -1 | 0) => {
        const el = scrollerRef.current;
        if (!el) return;
        const from = stepTarget.current ?? zoom;
        const want = dir === 0 ? fitZoom : dir > 0 ? from * ZOOM_STEP : from / ZOOM_STEP;
        const t = Math.min(maxZoom, Math.max(fitZoom, want));
        if (Math.abs(t - from) < 1e-3) return;
        if (stepTarget.current !== null && zoomAnim.current) {
          window.clearTimeout(zoomAnim.current.timer); // retarget: only the last tap commits
          zoomAnim.current = null;
        }
        stepTarget.current = t;
        const rect = el.parentElement!.getBoundingClientRect();
        scheduler.held = true;
        animatePreview(t / zoom, rect.width / 2, rect.height / 2, () => {
          stepTarget.current = null;
          scheduler.held = false;
          if (Math.abs(t - zoom) < 1e-3) return setPreview(1, 0, 0); // nothing to re-lay out
          zoomAt(t, rect.left + rect.width / 2, rect.top + rect.height / 2);
        });
      },
      [zoom, fitZoom, maxZoom, zoomAt, animatePreview, setPreview, scheduler],
    );

    // ---- scrubber micro-thumbnails: tiny renders that bypass the queue (they're <10 ms and the
    // reader isn't scrolling while you drag). A newer request cancels the one in flight, and a
    // small LRU makes dragging back and forth instant. Dropped on theme change and book close.
    const thumbs = useRef(new Map<string, HTMLCanvasElement>());
    const thumbJob = useRef<{ cancel: () => void } | null>(null);
    useEffect(() => {
      const cache = thumbs.current;
      return () => {
        thumbJob.current?.cancel();
        for (const c of cache.values()) c.width = 0;
        cache.clear();
      };
    }, [doc, theme]);
    const renderThumbnail = useCallback(
      async (n: number, widthPx: number): Promise<HTMLCanvasElement | null> => {
        if (!doc || n < 1 || n > doc.numPages) return null;
        const key = `${n}|${Math.round(widthPx)}`;
        const cache = thumbs.current;
        const hit = cache.get(key);
        if (hit) {
          cache.delete(key); // refresh LRU order
          cache.set(key, hit);
          return hit;
        }
        thumbJob.current?.cancel();
        let cancelled = false;
        let task: { cancel(): void; promise: Promise<unknown> } | null = null;
        thumbJob.current = {
          cancel: () => {
            cancelled = true;
            task?.cancel();
          },
        };
        try {
          const p = await doc.getPage(n);
          if (cancelled) return null;
          const vp = p.getViewport({ scale: widthPx / p.getViewport({ scale: 1 }).width });
          let canvas = document.createElement('canvas');
          canvas.width = Math.round(vp.width);
          canvas.height = Math.round(vp.height);
          task = p.render({ canvas, viewport: vp, background: '#ffffff' });
          await task.promise;
          if (cancelled) {
            canvas.width = 0;
            return null;
          }
          const imgs = isInverted(theme) ? toCanvasSpace(await pageImageMatrices(p, task), vp.transform) : [];
          if (cancelled) {
            canvas.width = 0;
            return null;
          }
          canvas = tintCanvas(canvas, theme, imgs);
          cache.set(key, canvas);
          while (cache.size > THUMB_CACHE) {
            const [oldKey, old] = cache.entries().next().value!;
            cache.delete(oldKey);
            old.width = 0;
          }
          return canvas;
        } catch {
          return null;
        }
      },
      [doc, theme],
    );

    // ---- page previews (see lib/previews.ts). Every first-pass render leaves one behind for
    // free; idle time prefetches the rest around the reader, leaning the way they're reading.
    // (Not rendered on landing: a small render costs nearly as much as the first pass, which is
    // mostly per-glyph work, so a landing goes straight to the visible pages' canvases.)
    const previews = useRef(new PreviewCache(PREVIEW_CACHE));
    const previewKey = useRef('');
    const [, setPreviewTick] = useState(0);
    const mountedRef = useRef<[number, number]>([1, 0]);
    if (previewKey.current !== `${theme}`) {
      previewKey.current = `${theme}`;
      previews.current.clear();
    }
    useEffect(() => {
      const cache = previews.current;
      return () => cache.clear();
    }, [doc]);
    const storePreview = useCallback(async (n: number, source: HTMLCanvasElement, forTheme: ReaderTheme) => {
      if (previews.current.has(n) || !source.width) return;
      const url = await encodePreview(source, PREVIEW_W);
      if (!url) return;
      // dropped if the theme changed while encoding
      if (forTheme !== propsRef.current.theme || previews.current.has(n)) return URL.revokeObjectURL(url);
      previews.current.set(n, url);
      const [mLo, mHi] = mountedRef.current;
      if (n >= mLo && n <= mHi) setPreviewTick((t) => t + 1);
    }, []);
    /** A page's first pass doubles as its preview: downscaled and encoded later, in idle time. */
    const onPainted = useCallback(
      (n: number, canvas: () => HTMLCanvasElement | null, forTheme: ReaderTheme) => {
        if (previews.current.has(n)) return;
        scheduler.requestIdle(`enc${n}`, 11, async () => {
          const c = canvas();
          if (c && forTheme === propsRef.current.theme) await storePreview(n, c, forTheme);
        });
      },
      [scheduler, storePreview],
    );
    const renderPreview = useCallback(
      async (n: number) => {
        if (!doc || previews.current.has(n)) return;
        const forTheme = propsRef.current.theme;
        const p = await doc.getPage(n);
        const unit = p.getViewport({ scale: 1 });
        reportSize(n, unit.width, unit.height); // a free size probe
        const vp = p.getViewport({ scale: PREVIEW_W / unit.width });
        let canvas = document.createElement('canvas');
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        const task = p.render({ canvas, viewport: vp, background: '#ffffff' });
        try {
          await task.promise;
        } catch {
          canvas.width = 0;
          return;
        }
        if (forTheme !== propsRef.current.theme) return void (canvas.width = 0);
        const imgs = isInverted(forTheme) ? toCanvasSpace(await pageImageMatrices(p, task), vp.transform) : [];
        canvas = tintCanvas(canvas, forTheme, imgs);
        await storePreview(n, canvas, forTheme);
        canvas.width = 0;
      },
      [doc, storePreview, reportSize],
    );
    useEffect(() => {
      if (!doc || !numPages) return;
      let cancelled = false;
      const pending = () => {
        const out: number[] = [];
        const fwd = dirRef.current;
        const ahead = PREVIEW_AHEAD;
        const behind = PREVIEW_BEHIND;
        // nearest first, roughly ahead:behind in proportion
        for (let d = 0; d <= ahead; d++) {
          for (const n of [page + fwd * d, ...(d <= behind && d ? [page - fwd * d] : [])]) {
            if (n < 1 || n > numPages) continue;
            if (previews.current.has(n)) previews.current.touch(n);
            else out.push(n);
          }
        }
        return out;
      };
      const step = async () => {
        for (const n of pending().slice(0, PREVIEW_BATCH)) {
          if (cancelled) return;
          await renderPreview(n);
        }
        if (!cancelled && pending().length) scheduler.requestIdle('preview', 12, step);
      };
      if (pending().length) scheduler.requestIdle('preview', 12, step);
      return () => {
        cancelled = true;
        scheduler.cancelIdle('preview');
      };
    }, [doc, numPages, page, theme, renderPreview, scheduler]);

    // ---- theme change: the visible pages are drawn in the new theme *before* it's applied, then
    // swapped in during the same commit (see PdfPage), so the crossfade lands on finished pages
    // instead of a light page repainting dark a beat later.
    const prepared = useRef(new Map<number, { key: string; canvas: HTMLCanvasElement }>());
    const prepareTheme = useCallback(
      async (next: ReaderTheme, timeoutMs = 700) => {
        const el = scrollerRef.current;
        if (!doc || !el || !numPages) return;
        for (const v of prepared.current.values()) v.canvas.width = 0;
        prepared.current.clear();
        const view = el.getBoundingClientRect();
        const nums: number[] = [];
        if (paged) nums.push(pageRef.current);
        else
          for (const [i, p] of pageRefs.current.entries()) {
            const r = p?.isConnected ? p.getBoundingClientRect() : null;
            if (r && r.bottom > view.top && r.top < view.bottom) nums.push(i + 1);
          }
        const work = Promise.all(
          nums.slice(0, 3).map(async (n) => {
            const i = n - 1;
            const scale = scaleOf(i);
            const ratio = firstPassRatio(sizes[i].w, sizes[i].h, scale);
            const canvas = await drawPage(doc, n, scale, ratio, next).catch(() => null);
            if (canvas) prepared.current.set(n, { key: canvasKey(scale, next), canvas });
          }),
        );
        await Promise.race([work, new Promise((r) => setTimeout(r, timeoutMs))]);
      },
      [doc, numPages, paged, scaleOf, sizes],
    );

    const getPageText = useCallback(
      async (n: number): Promise<string> => {
        if (!doc || n < 1 || n > doc.numPages) throw new Error('No such page');
        return pageTextFromItems((await (await doc.getPage(n)).getTextContent()).items as Array<{ str?: string }>);
      },
      [doc],
    );

    useImperativeHandle(
      ref,
      () => ({
        goToPage: (n, frac) => goToPage(n, false, frac),
        getDocument: () => doc,
        renderThumbnail,
        getPageText,
        next,
        prev,
        zoom: stepZoom,
        getOutline: async () => {
          if (!doc) return [];
          if (outline) return outline;
          const o = await readOutline(doc);
          setOutline(o);
          return o;
        },
        prepareTheme,
      }),
      [goToPage, renderThumbnail, getPageText, doc, next, prev, stepZoom, outline, prepareTheme],
    );

    // ---- keyboard
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if ((e.target as HTMLElement)?.closest?.('input, textarea')) return;
        if (e.key === 'ArrowRight' || e.key === 'PageDown') next();
        else if (e.key === 'ArrowLeft' || e.key === 'PageUp') prev();
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [next, prev]);

    // ---- pinch to zoom. While the fingers move, the only work per touch event is one transform on
    // the viewport-sized scroller (a compositor-only change; the render queue is held so pdf.js
    // never draws mid-gesture). Past the limits it rubber-bands; on release it springs back on the
    // compositor, then the page is laid out once at the new zoom and re-rendered sharp.
    useEffect(() => {
      const el = scrollerRef.current!;
      let pinch: { dist: number; ox: number; oy: number; mx: number; my: number } | null = null;
      let scale = 1;
      let frame = 0;
      const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
      const bounds = () => {
        const z = zoomRef.current;
        return { lo: limitsRef.current.min / z, hi: limitsRef.current.max / z };
      };
      const onStart = (e: TouchEvent) => {
        if (e.touches.length !== 2) return;
        zoomAnim.current?.done();
        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const rect = el.parentElement!.getBoundingClientRect();
        pinch = { dist: dist(e.touches) || 1, ox: mx - rect.left, oy: my - rect.top, mx, my };
        scale = 1;
        scheduler.held = true;
        setPreview(1, pinch.ox, pinch.oy);
      };
      const paint = () => {
        frame = 0;
        if (pinch) el.style.transform = `scale(${scale})`;
      };
      const onMove = (e: TouchEvent) => {
        // No preventDefault: `touch-action: pan-x pan-y` already stops Safari's page zoom, and a
        // non-passive touchmove would make every scroll gesture wait on the main thread.
        if (!pinch || e.touches.length !== 2) return;
        const { lo, hi } = bounds();
        scale = rubberBand(dist(e.touches) / pinch.dist, lo, hi);
        // coalesce to one style write per frame, however fast the touch events arrive
        if (!frame) frame = requestAnimationFrame(paint);
      };
      const onEnd = (e: TouchEvent) => {
        if (!pinch || e.touches.length >= 2) return;
        const { ox, oy, mx, my } = pinch;
        pinch = null;
        cancelAnimationFrame(frame);
        frame = 0;
        const { lo, hi } = bounds();
        const end = Math.min(hi, Math.max(lo, scale));
        const release = () => (scheduler.held = false);
        if (Math.abs(end - 1) < 0.03) {
          // nothing to change (or pinched out at the default): spring back to where it was
          animatePreview(1, ox, oy, () => {
            setPreview(1, ox, oy);
            release();
          });
          return;
        }
        const commit = () => {
          release();
          zoomAt(zoomRef.current * end, mx, my); // the transform is cleared in the layout effect
        };
        if (Math.abs(end - scale) > 1e-3) animatePreview(end, ox, oy, commit);
        else commit();
      };
      const stopGesture = (e: Event) => e.preventDefault();
      el.addEventListener('touchstart', onStart, { passive: true });
      el.addEventListener('touchmove', onMove, { passive: true });
      el.addEventListener('touchend', onEnd, { passive: true });
      el.addEventListener('touchcancel', onEnd, { passive: true });
      el.addEventListener('gesturestart', stopGesture);
      return () => {
        cancelAnimationFrame(frame);
        el.removeEventListener('touchstart', onStart);
        el.removeEventListener('touchmove', onMove);
        el.removeEventListener('touchend', onEnd);
        el.removeEventListener('touchcancel', onEnd);
        el.removeEventListener('gesturestart', stopGesture);
      };
    }, [zoomAt, scheduler, setPreview, animatePreview]);

    // ---- taps: edges turn pages (Pages mode), centre toggles the chrome
    const lastSelectionAt = useRef(0);
    useEffect(() => {
      const onSel = () => {
        const s = document.getSelection();
        if (s && !s.isCollapsed) lastSelectionAt.current = Date.now();
      };
      document.addEventListener('selectionchange', onSel);
      return () => document.removeEventListener('selectionchange', onSel);
    }, []);
    const onClick = (e: React.MouseEvent) => {
      const s = document.getSelection();
      if ((s && !s.isCollapsed) || Date.now() - lastSelectionAt.current < 500) return;
      const rect = scrollerRef.current!.getBoundingClientRect();
      const zone = paged ? tapZone(e.clientX - rect.left, rect.width) : 'center';
      if (zone === 'center') props.onCenterTap();
      else if (zone === 'next') next();
      else prev();
    };

    // stable so memoized pages don't re-render on every parent render
    const registerPage = useCallback((i: number, el: HTMLDivElement | null) => {
      pageRefs.current[i] = el;
    }, []);

    const [lo, hi] = range;
    const isActive = (n: number) => n >= lo && n <= hi;
    const ready = doc && numPages > 0 && viewport.w > 0;

    // Only the boxes around the current page (plus the live canvas range) are mounted, so a zoom
    // re-lays out a fixed number of pages however long the PDF is. Scroll mode: ~17 boxes, spacers
    // stand in for the rest. Pages mode: the prefetched previews' range (so a jump still lands on
    // one), the other slots stay as empty snap stops.
    const around = paged ? PREVIEW_AHEAD : MOUNT_AROUND;
    const at = paged ? page : mountAt;
    const mountLo = Math.max(1, Math.min(lo, at - around));
    const mountHi = Math.min(numPages, Math.max(hi, at + around));
    /** Left offset that centres the text column in the safe area at the default zoom. */
    const fitShift = (w: number) => (fitting && textBox ? Math.round(safeMid - ((textBox.x0 + textBox.x1) / 2) * w) : undefined);
    const sideInsets = insets.l + insets.r;
    mountedRef.current = [mountLo, mountHi];

    const renderPage = (i: number) => {
      const n = i + 1;
      const { w, h } = cssSize(i);
      const node = (
        <PdfPage
          key={n}
          index={i}
          register={registerPage}
          doc={doc!}
          num={n}
          baseW={sizes[i].w}
          baseH={sizes[i].h}
          width={w}
          height={h}
          scale={scaleOf(i)}
          active={isActive(n)}
          current={n === page}
          theme={theme}
          preview={previews.current.get(n)}
          scheduler={scheduler}
          onRealSize={reportSize}
          onPainted={onPainted}
          prepared={prepared.current}
          shift={fitShift(w)}
        />
      );
      if (!paged) return node;
      return (
        <div
          key={n}
          ref={(el) => {
            slotRefs.current[i] = el;
          }}
          // only live slots are scroll containers: on iOS every overflow:auto element is its
          // own native scroll view, and hundreds of them make the carousel stutter
          className={isActive(n) ? 'pdf-slot is-live' : 'pdf-slot'}
        >
          <div
            className="pdf-slot-inner"
            style={{ width: fitting ? viewport.w : Math.max(viewport.w, w + PAD * 2 + sideInsets) }}
          >
            {node}
          </div>
        </div>
      );
    };

    const pageNodes: React.ReactNode[] = [];
    if (ready && paged) {
      for (let i = 0; i < numPages; i++) {
        const n = i + 1;
        if (n >= mountLo && n <= mountHi) pageNodes.push(renderPage(i));
        else pageNodes.push(<div key={n} className="pdf-slot" ref={(el) => void (slotRefs.current[i] = el)} />);
      }
    } else if (ready) for (let i = mountLo - 1; i < mountHi; i++) pageNodes.push(renderPage(i));

    // Spacers look like a column of blank pages, so a fast fling past the mounted boxes still
    // shows pages (exact for uniform PDFs, close enough for mixed ones until it settles).
    const spacer = (height: number) => {
      if (!ready || height <= 0) return null;
      const { w, h } = cssSize(0);
      const bg = PAGE_BG[theme];
      const shift = fitShift(w);
      return (
        <div
          aria-hidden
          className="pdf-spacer"
          style={{
            height,
            backgroundImage: `repeating-linear-gradient(to bottom, ${bg} 0, ${bg} ${h}px, transparent ${h}px, transparent ${h + GAP}px)`,
            backgroundSize: `${w}px 100%`,
            backgroundPosition: shift !== undefined ? `${shift}px top` : undefined,
          }}
        />
      );
    };

    return (
      <div
        className={`relative h-full w-full pdf-theme-${theme}${fitting ? ' fit-text' : ''}`}
        style={{ background: 'var(--reader-bg)' }}
      >
        <div
          ref={scrollerRef}
          onClick={onClick}
          className={paged ? 'pdf-scroller pdf-paged' : 'pdf-scroller pdf-scrolled'}
          data-flow={flow}
        >
          {paged ? (
            pageNodes
          ) : (
            <div
              ref={trackRef}
              className="pdf-track"
              style={{ width: fitting ? viewport.w : Math.max(viewport.w, geo.maxW + PAD * 2 + sideInsets) }}
            >
              {ready && spacer(geo.tops[mountLo - 1])}
              {pageNodes}
              {ready && spacer(geo.tops[numPages] - geo.tops[mountHi])}
            </div>
          )}
        </div>

        <div ref={insetProbe} className="safe-probe" aria-hidden />
        {!doc && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          </div>
        )}
      </div>
    );
  }),
);

export default PdfReader;

// ---------------------------------------------------------------------------

interface PageProps {
  index: number;
  register: (index: number, el: HTMLDivElement | null) => void;
  doc: PDFDocumentProxy;
  num: number;
  /** Size at scale 1 that the layout assumed (real or estimated). */
  baseW: number;
  baseH: number;
  width: number;
  height: number;
  scale: number;
  active: boolean;
  current: boolean;
  theme: ReaderTheme;
  /** Blob URL of this page's preview, painted under the canvas (and instead of it while none). */
  preview: string | undefined;
  scheduler: RenderScheduler;
  onRealSize: (num: number, w: number, h: number) => void;
  onPainted: (num: number, canvas: () => HTMLCanvasElement | null, theme: ReaderTheme) => void;
  /** Canvases already drawn for a theme that's about to apply (see prepareTheme). */
  prepared: Map<number, { key: string; canvas: HTMLCanvasElement }>;
  /** Fit text: left offset that centres the text column; the margins hang off screen, clipped. */
  shift?: number;
}

/**
 * A page box at its final CSS size. While active it holds a canvas (stretched to the box, so a
 * zoom or rotation shows the old bitmap scaled on the GPU until the sharp re-render lands) and a
 * text layer. pdf.js positions text-layer spans in percentages scaled by --total-scale-factor,
 * so the text layer only needs that variable updated on zoom, not a re-render.
 */
// memo: during a scroll the parent re-renders (current page, range); untouched pages must not.
const PdfPage = memo(function PdfPage({
  index,
  register,
  doc,
  num,
  baseW,
  baseH,
  width,
  height,
  scale,
  active,
  current,
  theme,
  preview,
  scheduler,
  onRealSize,
  onPainted,
  prepared,
  shift,
}: PageProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const rendered = useRef<{ key: string; sharp: boolean; canvas: HTMLCanvasElement } | null>(null);
  const textDone = useRef(false);

  /** Puts a finished canvas in the box, freeing the one it replaces. */
  const place = (box: HTMLDivElement, canvas: HTMLCanvasElement, key: string, sharp: boolean) => {
    const old = rendered.current?.canvas;
    box.prepend(canvas);
    if (old) {
      old.width = 0;
      old.remove();
    }
    rendered.current = { key, sharp, canvas };
  };

  // theme change: take the canvas drawn ahead for this page, in the same commit as the theme
  useLayoutEffect(() => {
    const box = boxRef.current;
    const hit = prepared.get(num);
    if (!box || !active || !hit) return;
    prepared.delete(num);
    if (hit.key !== canvasKey(scale, theme)) return void (hit.canvas.width = 0);
    place(box, hit.canvas, hit.key, false);
    onPainted(num, () => rendered.current?.canvas ?? null, theme);
  }, [theme, scale, active, num, prepared, onPainted]);

  // canvas: first pass (capped at 2x DPR / 2.2 MP) via the main queue; for the current page a
  // sharp pass (full DPR, up to 4.5 MP) as an idle task once the reader has settled on it.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const queueKey = `c${num}`;
    if (!active) {
      scheduler.cancel(queueKey);
      scheduler.cancelIdle(`sharp${num}`);
      if (rendered.current) {
        // free the bitmap right away: iOS counts canvas memory until the element is collected
        rendered.current.canvas.width = 0;
        rendered.current.canvas.height = 0;
        rendered.current.canvas.remove();
        rendered.current = null;
      }
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const key = canvasKey(scale, theme);
    const area = baseW * scale * baseH * scale;
    const firstRatio = firstPassRatio(baseW, baseH, scale);
    const sharpRatio = Math.min(dpr, Math.sqrt(SHARP_PASS_PIXELS / area));
    const needsSharp = sharpRatio > firstRatio * 1.05;
    let cancelled = false;
    let renderTask: { cancel(): void } | null = null;

    const draw = async (sharp: boolean) => {
      if (cancelled) return;
      const p = await doc.getPage(num);
      if (cancelled) return;
      const unit = p.getViewport({ scale: 1 });
      if (Math.abs(unit.width - baseW) > 1 || Math.abs(unit.height - baseH) > 1) {
        // the layout guessed this page's size; report it and render again at the right size
        onRealSize(num, unit.width, unit.height);
        return;
      }
      const canvas = await drawPage(
        doc,
        num,
        scale,
        sharp ? sharpRatio : firstRatio,
        theme,
        (t) => (renderTask = t),
        () => cancelled,
      );
      if (!canvas) return;
      place(box, canvas, key, sharp || !needsSharp);
      if (!sharp) onPainted(num, () => rendered.current?.canvas ?? null, theme);
    };

    if (rendered.current?.key !== key) scheduler.request(queueKey, num, BIAS_CANVAS, () => draw(false));
    if (current && needsSharp) {
      scheduler.requestIdle(`sharp${num}`, 0, async () => {
        if (rendered.current?.key === key && !rendered.current.sharp) await draw(true);
      });
    }
    return () => {
      cancelled = true;
      scheduler.cancel(queueKey);
      scheduler.cancelIdle(`sharp${num}`);
      renderTask?.cancel();
    };
  }, [active, current, scale, theme, num, baseW, baseH, doc, scheduler, onRealSize, onPainted]);

  // text layer (scale-independent)
  useEffect(() => {
    const tl = textRef.current;
    if (!tl) return;
    if (!active) {
      tl.replaceChildren();
      textDone.current = false;
      return;
    }
    if (textDone.current) return;
    let cancelled = false;
    let layer: InstanceType<typeof pdfjs.TextLayer> | null = null;
    // TextLayer measures every span (measureText + DOM writes), so it goes through the
    // scheduler too: it never runs mid-scroll and never alongside a canvas render.
    const key = `t${num}`;
    scheduler.request(key, num, BIAS_TEXT, async () => {
      if (cancelled) return;
      const p = await doc.getPage(num);
      const content = await p.getTextContent();
      if (cancelled) return;
      layer = new pdfjs.TextLayer({ textContentSource: content, container: tl, viewport: p.getViewport({ scale: 1 }) });
      await layer.render();
      if (cancelled) return;
      const end = document.createElement('div');
      end.className = 'endOfContent';
      tl.append(end);
      textDone.current = true;
    });
    return () => {
      cancelled = true;
      scheduler.cancel(key);
      layer?.cancel();
    };
  }, [active, num, doc, scheduler]);

  return (
    <div
      ref={(el) => {
        boxRef.current = el;
        register(index, el);
      }}
      className="pdf-page"
      data-page={num}
      role="group"
      aria-roledescription="page"
      aria-label={`Page ${num}`}
      style={{
        width,
        height,
        marginLeft: shift,
        backgroundColor: PAGE_BG[theme],
        backgroundImage: preview ? `url(${preview})` : undefined,
        backgroundSize: '100% 100%',
        ['--total-scale-factor' as string]: scale,
        ['--scale-factor' as string]: scale,
      }}
    >
      <div ref={textRef} className="textLayer" />
    </div>
  );
});
