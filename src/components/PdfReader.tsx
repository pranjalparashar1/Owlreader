import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { pdfjs, type PDFDocumentProxy } from '../lib/pdfjs';
import { localFlag } from '../lib/settings';
import type { ReaderTheme } from '../types';
import { tapZone, type ReaderHandle, type ReaderProps } from './readerTypes';
import { CloseIcon } from './icons';

const MIN_ZOOM = 0.6;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;
const PAD = 8; // breathing room around a page at fit-width
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
const THUMB_CACHE = 48; // scrubber micro-thumbnails kept (≈0.04 MP each, ~7 MB worst case)

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/**
 * Dark and sepia are baked into each page bitmap with canvas compositing (see `tintCanvas`),
 * so the compositor only ever scrolls plain opaque bitmaps. A CSS `filter` forced iOS to
 * re-filter every page on every frame; pdf.js's `pageColors` needs `ctx.filter`, which iOS
 * Safari lacks. Box colour shown before a page has rendered, matching the tinted page:
 */
const PAGE_BG: Record<ReaderTheme, string> = { light: '#ffffff', sepia: '#f6eedd', dark: '#1f1f1f' };

type Size = { w: number; h: number };
type Task = () => Promise<void>;

/** Text-layer tasks sort just after their page's canvas (same distance, canvas first). */
const textKey = (num: number) => num + 0.5;

/**
 * One pdf.js job at a time, and never while the user is scrolling: pdf.js draws on the main
 * thread, so rendering mid-gesture is what makes native scrolling stutter on iPhone.
 * - `request`: first-pass canvases and text layers, nearest-to-current page first.
 * - `requestIdle`: sharp passes and page-size probes. They run only when nothing else is queued
 *   and the reader has been still for QUIET_MS, lowest `prio` first.
 */
class RenderScheduler {
  private queue = new Map<number, Task>();
  private idle = new Map<string, { prio: number; task: Task }>();
  private running = false;
  private timer: number | undefined;
  private quietSince = performance.now();
  private _scrolling = false;
  current = 1;
  get scrolling() {
    return this._scrolling;
  }
  set scrolling(v: boolean) {
    this._scrolling = v;
    if (!v) this.quietSince = performance.now();
  }
  request(num: number, task: Task) {
    this.queue.set(num, task);
    this.pump();
  }
  cancel(num: number) {
    this.queue.delete(num);
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
    if (this.running || this._scrolling) return;
    let task: Task | undefined;
    if (this.queue.size) {
      let best = -1;
      for (const n of this.queue.keys()) if (best < 0 || Math.abs(n - this.current) < Math.abs(best - this.current)) best = n;
      task = this.queue.get(best)!;
      this.queue.delete(best);
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

/**
 * Bakes the reading theme into a rendered page. Dark ≈ CSS `invert(0.88) hue-rotate(180deg)`:
 * invert, pull the contrast in, then put the original hues back with the `hue` blend mode
 * (photos keep their colours, only lightness flips). Sepia multiplies by the paper colour.
 * Every step is a GPU canvas op, no `ctx.filter` and no pixel readback.
 */
function tintCanvas(canvas: HTMLCanvasElement, theme: ReaderTheme): HTMLCanvasElement {
  if (theme === 'light') return canvas;
  const { width: w, height: h } = canvas;
  if (theme === 'sepia') {
    const ctx = canvas.getContext('2d')!;
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = PAGE_BG.sepia;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    return canvas;
  }
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(canvas, 0, 0);
  ctx.globalCompositeOperation = 'difference';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h); // invert
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 0.24;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, w, h); // white→#1f1f1f, black→#e0e0e0 (the 0.88 in invert(0.88))
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'hue';
  ctx.drawImage(canvas, 0, 0); // original hue, inverted lightness
  ctx.globalCompositeOperation = 'source-over';
  canvas.width = 0; // free the untinted bitmap
  return out;
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
 * Zoom is a multiplier of fit-to-width, so rotating keeps the same page and relative zoom.
 */
const PdfReader = forwardRef<ReaderHandle, Props>(function PdfReader(props, ref) {
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
  const [zoom, setZoom] = useState(() => clampZoom(book.progress.pdfScale ?? 1));
  const [viewport, setViewport] = useState<Size>({ w: 0, h: 0 });
  const [range, setRange] = useState<[number, number]>([page - 1, page + 1]);
  const [textless, setTextless] = useState<Set<number>>(() => new Set());
  const scanKey = `owl.scanBanner.${book.id}`;
  const [bannerDismissed, setBannerDismissed] = useState(() => localFlag(scanKey)[0]);

  const numPages = sizes.length;
  const pageRef = useRef(page);
  pageRef.current = page;
  scheduler.current = page;

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
    return () => ro.disconnect();
  }, []);

  // ---- per-page CSS size
  const availW = Math.max(100, viewport.w - PAD * 2);
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
      // visible range plus lookahead: 1.5 screens above, 2.5 below
      let first = a;
      while (first > 0 && tops[first] > top - el.clientHeight * 1.5) first--;
      let last = a;
      while (last < numPages - 1 && tops[last + 1] < top + el.clientHeight * 2.5) last++;
      lo = first + 1;
      hi = last + 1;
    }
    anchor.current = { page: current, frac };
    if (current !== pageRef.current) setPage(current);
    setRange((r) => (r[0] === lo && r[1] === hi ? r : [lo, hi]));
  }, [numPages, paged]);

  // ---- restore position after anything that changes layout (open, rotate, zoom, flow)
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || !numPages || !viewport.w) return;
    const focal = zoomFocal.current;
    zoomFocal.current = null;
    // clear any pinch preview transform now that real sizes are in the DOM
    for (const p of pageRefs.current) if (p?.style.transform) p.style.transform = '';
    if (trackRef.current?.style.transform) trackRef.current.style.transform = '';

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
    const settle = () => {
      scheduler.scrolling = false;
      locate();
      flushSizes();
      scheduler.pump();
    };
    const onScroll = () => {
      scheduler.scrolling = true;
      window.clearTimeout(idle);
      idle = window.setTimeout(settle, SCROLL_IDLE_MS);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // in Pages mode the live slots scroll vertically too (tall or zoomed pages)
    el.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('scroll', onScroll, { capture: true });
      window.clearTimeout(idle);
    };
  }, [locate, scheduler, flushSizes]);

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
  const firstReport = useRef(true);
  useEffect(() => {
    if (!numPages) return;
    const fraction = numPages > 1 ? (page - 1) / (numPages - 1) : 1;
    propsRef.current.onLocation({ fraction, page, pageCount: numPages, label: `Page ${page} of ${numPages}`, zoom });
    propsRef.current.onProgressChange({
      pdfPage: page,
      pdfScale: zoom,
      percentage: Math.round((page / numPages) * 1000) / 10,
    });
    if (firstReport.current) firstReport.current = false;
    else propsRef.current.onPageTurn();
  }, [page, zoom, numPages]);

  const goToPage = useCallback(
    (n: number, smooth = false) => {
      const el = scrollerRef.current;
      if (!el || !numPages) return;
      const target = Math.min(numPages, Math.max(1, Math.round(n)));
      const behavior: ScrollBehavior = smooth && Math.abs(target - pageRef.current) <= 2 ? 'smooth' : 'instant';
      if (paged) el.scrollTo({ left: (target - 1) * el.clientWidth, behavior });
      else el.scrollTo({ top: padTop() + geoRef.current.tops[target - 1] - PAD, behavior });
      if (behavior === 'instant') requestAnimationFrame(locate);
    },
    [numPages, paged, locate],
  );

  const next = useCallback(() => {
    const el = scrollerRef.current;
    if (!paged && el) el.scrollBy({ top: el.clientHeight * 0.85, behavior: 'smooth' });
    else goToPage(pageRef.current + 1, true);
  }, [goToPage, paged]);
  const prev = useCallback(() => {
    const el = scrollerRef.current;
    if (!paged && el) el.scrollBy({ top: -el.clientHeight * 0.85, behavior: 'smooth' });
    else goToPage(pageRef.current - 1, true);
  }, [goToPage, paged]);

  /** Change zoom keeping the point under (mx, my) — viewport coords — fixed on screen. */
  const zoomAt = useCallback(
    (nextZoom: number, mx?: number, my?: number) => {
      const el = scrollerRef.current;
      const z = clampZoom(nextZoom);
      if (!el || z === zoom) return;
      const p = pageRef.current;
      const pageEl = pageRefs.current[p - 1];
      const container = paged ? slotRefs.current[p - 1] : el;
      if (pageEl && container) {
        const rect = container.getBoundingClientRect();
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
      setZoom(z);
    },
    [zoom, paged],
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
        canvas = tintCanvas(canvas, theme);
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

  useImperativeHandle(
    ref,
    () => ({
      goToPage: (n) => goToPage(n),
      renderThumbnail,
      next,
      prev,
      zoom: (dir) => zoomAt(dir === 0 ? 1 : dir > 0 ? zoom * ZOOM_STEP : zoom / ZOOM_STEP),
    }),
    [goToPage, renderThumbnail, next, prev, zoom, zoomAt],
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

  // ---- pinch to zoom: GPU transform preview while pinching, one crisp re-render at the end
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const el = scrollerRef.current!;
    let pinch: { dist: number; mx: number; my: number; target: HTMLElement } | null = null;
    let scale = 1;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const p = pageRef.current;
      const pageEl = pageRefs.current[p - 1];
      const target = paged ? pageEl : trackRef.current;
      const container = paged ? slotRefs.current[p - 1] : el;
      if (!target || !container || !pageEl) return;
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const rect = container.getBoundingClientRect();
      const ox = container.scrollLeft + mx - rect.left - (paged ? pageEl.offsetLeft : 0);
      const oy = container.scrollTop + my - rect.top - (paged ? pageEl.offsetTop : 0);
      target.style.transformOrigin = `${ox}px ${oy}px`;
      target.style.willChange = 'transform';
      pinch = { dist: dist(e.touches), mx, my, target };
      scale = 1;
    };
    const onMove = (e: TouchEvent) => {
      // No preventDefault: `touch-action: pan-x pan-y` already stops Safari's page zoom, and a
      // non-passive touchmove would make every scroll gesture wait on the main thread.
      if (!pinch || e.touches.length !== 2) return;
      const z = zoomRef.current;
      scale = Math.min(MAX_ZOOM / z, Math.max(MIN_ZOOM / z, dist(e.touches) / pinch.dist));
      pinch.target.style.transform = `scale(${scale})`;
    };
    const onEnd = (e: TouchEvent) => {
      if (!pinch || e.touches.length >= 2) return;
      const { mx, my, target } = pinch;
      pinch = null;
      target.style.willChange = '';
      if (Math.abs(scale - 1) < 0.03) target.style.transform = '';
      else zoomAt(zoomRef.current * scale, mx, my); // transform is cleared in the layout effect
    };
    const stopGesture = (e: Event) => e.preventDefault();
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    el.addEventListener('gesturestart', stopGesture);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      el.removeEventListener('gesturestart', stopGesture);
    };
  }, [paged, zoomAt]);

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
  const onTextInfo = useCallback((num: number, hasText: boolean) => {
    setTextless((prev) => {
      if (hasText === !prev.has(num)) return prev;
      const s = new Set(prev);
      if (hasText) s.delete(num);
      else s.add(num);
      return s;
    });
  }, []);

  const [lo, hi] = range;
  const isActive = (n: number) => n >= lo && n <= hi;
  const ready = doc && numPages > 0 && viewport.w > 0;

  // Scroll mode mounts only the boxes around the current page (plus the live canvas range);
  // spacers above and below stand in for the rest, so DOM size is flat however long the PDF is.
  const mountLo = paged ? 1 : Math.max(1, Math.min(lo, page - MOUNT_AROUND));
  const mountHi = paged ? numPages : Math.min(numPages, Math.max(hi, page + MOUNT_AROUND));

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
        scheduler={scheduler}
        onTextInfo={onTextInfo}
        onRealSize={reportSize}
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
        <div className="pdf-slot-inner" style={{ width: Math.max(viewport.w, w + PAD * 2) }}>
          {node}
        </div>
      </div>
    );
  };

  const pageNodes: React.ReactNode[] = [];
  if (ready) for (let i = mountLo - 1; i < mountHi; i++) pageNodes.push(renderPage(i));

  // Spacers look like a column of blank pages, so a fast fling past the mounted boxes still
  // shows pages (exact for uniform PDFs, close enough for mixed ones until it settles).
  const spacer = (height: number) => {
    if (!ready || height <= 0) return null;
    const { w, h } = cssSize(0);
    const bg = PAGE_BG[theme];
    return (
      <div
        aria-hidden
        className="pdf-spacer"
        style={{
          height,
          backgroundImage: `repeating-linear-gradient(to bottom, ${bg} 0, ${bg} ${h}px, transparent ${h}px, transparent ${h + GAP}px)`,
          backgroundSize: `${w}px 100%`,
        }}
      />
    );
  };

  return (
    <div className={`relative h-full w-full pdf-theme-${theme}`} style={{ background: 'var(--reader-bg)' }}>
      <div
        ref={scrollerRef}
        onClick={onClick}
        className={paged ? 'pdf-scroller pdf-paged' : 'pdf-scroller pdf-scrolled'}
        data-flow={flow}
      >
        {paged ? (
          pageNodes
        ) : (
          <div ref={trackRef} className="pdf-track" style={{ width: Math.max(viewport.w, geo.maxW + PAD * 2) }}>
            {ready && spacer(geo.tops[mountLo - 1])}
            {pageNodes}
            {ready && spacer(geo.tops[numPages] - geo.tops[mountHi])}
          </div>
        )}
      </div>

      {!doc && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      )}

      {textless.has(page) && !bannerDismissed && (
        <div
          role="status"
          className="absolute inset-x-3 z-[35] mx-auto flex max-w-md items-center gap-3 rounded-xl bg-fg/90 px-4 py-2.5 text-[13px] text-bg shadow-lg backdrop-blur"
          style={{ top: 'calc(60px + env(safe-area-inset-top))' }}
        >
          <span className="flex-1">Scanned page detected—text selection isn't available on this page.</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              localFlag(scanKey)[1]();
              setBannerDismissed(true);
            }}
            className="rounded-full p-1 opacity-80 hover:opacity-100"
            aria-label="Dismiss"
          >
            <CloseIcon size={16} />
          </button>
        </div>
      )}
    </div>
  );
});

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
  scheduler: RenderScheduler;
  onTextInfo: (num: number, hasText: boolean) => void;
  onRealSize: (num: number, w: number, h: number) => void;
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
  scheduler,
  onTextInfo,
  onRealSize,
}: PageProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const rendered = useRef<{ key: string; sharp: boolean; canvas: HTMLCanvasElement } | null>(null);
  const textDone = useRef(false);

  // canvas: first pass (capped at 2x DPR / 2.2 MP) via the main queue; for the current page a
  // sharp pass (full DPR, up to 4.5 MP) as an idle task once the reader has settled on it.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    if (!active) {
      scheduler.cancel(num);
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
    const key = `${scale.toFixed(4)}|${dpr}|${theme}`;
    const area = baseW * scale * baseH * scale;
    const firstRatio = Math.min(dpr, FIRST_PASS_MAX_DPR, Math.sqrt(FIRST_PASS_PIXELS / area));
    const sharpRatio = Math.min(dpr, Math.sqrt(SHARP_PASS_PIXELS / area));
    const needsSharp = sharpRatio > firstRatio * 1.05;
    let cancelled = false;
    let renderTask: { cancel(): void; promise: Promise<unknown> } | null = null;

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
      const viewport = p.getViewport({ scale });
      const ratio = sharp ? sharpRatio : firstRatio;
      let canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      renderTask = p.render({
        canvas,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
        background: '#ffffff',
      });
      try {
        await renderTask.promise;
      } catch {
        canvas.width = 0;
        return;
      }
      if (cancelled) {
        canvas.width = 0;
        return;
      }
      canvas = tintCanvas(canvas, theme);
      canvas.className = 'pdf-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      const old = rendered.current?.canvas;
      box.prepend(canvas);
      if (old) {
        old.width = 0;
        old.remove();
      }
      rendered.current = { key, sharp: sharp || !needsSharp, canvas };
    };

    if (rendered.current?.key !== key) scheduler.request(num, () => draw(false));
    if (current && needsSharp) {
      scheduler.requestIdle(`sharp${num}`, 0, async () => {
        if (rendered.current?.key === key && !rendered.current.sharp) await draw(true);
      });
    }
    return () => {
      cancelled = true;
      scheduler.cancel(num);
      scheduler.cancelIdle(`sharp${num}`);
      renderTask?.cancel();
    };
  }, [active, current, scale, theme, num, baseW, baseH, doc, scheduler, onRealSize]);

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
    const key = textKey(num);
    scheduler.request(key, async () => {
      if (cancelled) return;
      const p = await doc.getPage(num);
      const content = await p.getTextContent();
      if (cancelled) return;
      onTextInfo(num, content.items.some((it) => 'str' in it && /\S/.test(it.str)));
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
  }, [active, num, doc, onTextInfo, scheduler]);

  return (
    <div
      ref={(el) => {
        boxRef.current = el;
        register(index, el);
      }}
      className="pdf-page"
      data-page={num}
      style={{ width, height, background: PAGE_BG[theme], ['--total-scale-factor' as string]: scale, ['--scale-factor' as string]: scale }}
    >
      <div ref={textRef} className="textLayer" />
    </div>
  );
});
