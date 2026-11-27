import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { pdfjs, type PDFDocumentProxy } from '../lib/pdfjs';
import { localFlag } from '../lib/settings';
import type { ReaderTheme } from '../types';
import { tapZone, type ReaderHandle, type ReaderProps } from './readerTypes';
import { CloseIcon } from './icons';

const MIN_ZOOM = 0.6;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;
const PAD = 8; // breathing room around a page at fit-width
const MAX_CANVAS_PIXELS = 6_000_000; // keeps 3–5 live canvases well under iOS Safari's canvas memory cap
const SCROLL_IDLE_MS = 140;

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Theme colours are applied by pdf.js while drawing (no CSS filter on huge layers while scrolling). */
const PAGE_COLORS: Record<ReaderTheme, { background: string; foreground: string } | undefined> = {
  light: undefined,
  sepia: { background: '#f4ecd8', foreground: '#3b2d1c' },
  dark: { background: '#1b1b1b', foreground: '#d6d3d1' },
};
const PAGE_BG: Record<ReaderTheme, string> = { light: '#ffffff', sepia: '#f4ecd8', dark: '#1b1b1b' };

type Size = { w: number; h: number };

/**
 * One render at a time, nearest-to-current page first, and never while the user is
 * scrolling: pdf.js draws on the main thread, so rendering mid-gesture is what makes
 * native scrolling stutter on iPhone.
 */
class RenderScheduler {
  private queue = new Map<number, () => Promise<void>>();
  private running = false;
  scrolling = false;
  current = 1;
  request(num: number, task: () => Promise<void>) {
    this.queue.set(num, task);
    this.pump();
  }
  cancel(num: number) {
    this.queue.delete(num);
  }
  pump = () => {
    if (this.running || this.scrolling || this.queue.size === 0) return;
    let best = -1;
    for (const n of this.queue.keys()) if (best < 0 || Math.abs(n - this.current) < Math.abs(best - this.current)) best = n;
    const task = this.queue.get(best)!;
    this.queue.delete(best);
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
 * Pages are virtualized (only nearby pages hold a canvas). Each page has a canvas rendered
 * at devicePixelRatio and PDF.js's TextLayer on top, so native text selection works.
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

  // ---- load document + page sizes
  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) });
    task.promise.then(
      async (d) => {
        if (cancelled) return void d.destroy();
        loaded = d;
        const first = (await d.getPage(1)).getViewport({ scale: 1 });
        if (cancelled) return;
        const initial = Array.from({ length: d.numPages }, () => ({ w: first.width, h: first.height }));
        const start = Math.min(Math.max(1, pageRef.current), d.numPages);
        anchor.current = { page: start, frac: 0 };
        needsRestore.current = true;
        setPage(start);
        setRange([start - 1, start + 1]);
        setSizes(initial);
        setDoc(d);
        // Most PDFs are uniform; fetch real sizes in the background and update once if any differ.
        const real = initial.slice();
        let differs = false;
        for (let i = 2; i <= d.numPages && !cancelled; i++) {
          const v = (await d.getPage(i)).getViewport({ scale: 1 });
          if (Math.abs(v.width - first.width) > 1 || Math.abs(v.height - first.height) > 1) {
            real[i - 1] = { w: v.width, h: v.height };
            differs = true;
          }
          if (i % 25 === 0) await new Promise((r) => setTimeout(r, 0));
        }
        if (!cancelled && differs) {
          needsRestore.current = true;
          setSizes(real);
        }
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
  const maxW = useMemo(() => {
    let m = 0;
    for (let i = 0; i < sizes.length; i++) m = Math.max(m, Math.floor(sizes[i].w * scaleOf(i)));
    return m;
  }, [sizes, scaleOf]);

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
      const top = el.scrollTop;
      const probe = top + el.clientHeight * 0.3;
      const pages = pageRefs.current;
      // binary search the last page whose top is above the probe line
      let a = 0;
      let b = numPages - 1;
      while (a < b) {
        const m = (a + b + 1) >> 1;
        if ((pages[m]?.offsetTop ?? 0) <= probe) a = m;
        else b = m - 1;
      }
      current = a + 1;
      const el0 = pages[a];
      if (el0) frac = (top - el0.offsetTop) / Math.max(1, el0.offsetHeight);
      // visible range plus one screen of lookahead either side
      let first = a;
      while (first > 0 && (pages[first]?.offsetTop ?? 0) + (pages[first]?.offsetHeight ?? 0) > top - el.clientHeight) first--;
      let last = a;
      while (last < numPages - 1 && (pages[last + 1]?.offsetTop ?? Infinity) < top + el.clientHeight * 2) last++;
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
      const pageEl = pageRefs.current[p - 1];
      if (pageEl) el.scrollTop = pageEl.offsetTop + frac * pageEl.offsetHeight;
    }
    locate();
  }, [viewport, zoom, sizes, paged, numPages, locate]);


  // ---- scroll handling: track position, pause rendering while moving
  useEffect(() => {
    const el = scrollerRef.current!;
    let frame = 0;
    let idle: number | undefined;
    const onScroll = () => {
      scheduler.scrolling = true;
      window.clearTimeout(idle);
      idle = window.setTimeout(() => {
        scheduler.scrolling = false;
        locate();
        scheduler.pump();
      }, SCROLL_IDLE_MS);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(locate);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // in Pages mode each slot scrolls vertically too (tall or zoomed pages)
    el.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('scroll', onScroll, { capture: true });
      cancelAnimationFrame(frame);
      window.clearTimeout(idle);
    };
  }, [locate, scheduler]);

  // ---- report progress through the shell's single funnel
  const firstReport = useRef(true);
  useEffect(() => {
    if (!numPages) return;
    const fraction = numPages > 1 ? (page - 1) / (numPages - 1) : 1;
    propsRef.current.onLocation({ fraction, page, pageCount: numPages, label: `Page ${page} of ${numPages}` });
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
      else {
        const p = pageRefs.current[target - 1];
        if (p) el.scrollTo({ top: p.offsetTop - PAD, behavior });
      }
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

  useImperativeHandle(
    ref,
    () => ({
      goToFraction: (f) => goToPage(1 + f * (numPages - 1)),
      goToPage: (n) => goToPage(n),
      next,
      prev,
      zoom: (dir) => zoomAt(dir === 0 ? 1 : dir > 0 ? zoom * ZOOM_STEP : zoom / ZOOM_STEP),
    }),
    [goToPage, next, prev, numPages, zoom, zoomAt],
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
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
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
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
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

  const pageNodes = ready
    ? sizes.map((_, i) => {
        const n = i + 1;
        const { w, h } = cssSize(i);
        const node = (
          <PdfPage
            key={n}
            ref={(el) => {
              pageRefs.current[i] = el;
            }}
            doc={doc}
            num={n}
            width={w}
            height={h}
            scale={scaleOf(i)}
            active={isActive(n)}
            theme={theme}
            scheduler={scheduler}
            onTextInfo={onTextInfo}
          />
        );
        if (!paged) return node;
        return (
          <div
            key={n}
            ref={(el) => {
              slotRefs.current[i] = el;
            }}
            className="pdf-slot"
          >
            <div className="pdf-slot-inner" style={{ width: Math.max(viewport.w, w + PAD * 2) }}>
              {node}
            </div>
          </div>
        );
      })
    : null;

  return (
    <div className="relative h-full w-full" style={{ background: 'var(--reader-bg)' }}>
      <div
        ref={scrollerRef}
        onClick={onClick}
        className={paged ? 'pdf-scroller pdf-paged' : 'pdf-scroller pdf-scrolled'}
        data-flow={flow}
      >
        {paged ? (
          pageNodes
        ) : (
          <div ref={trackRef} className="pdf-track" style={{ width: Math.max(viewport.w, maxW + PAD * 2) }}>
            {pageNodes}
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
  doc: PDFDocumentProxy;
  num: number;
  width: number;
  height: number;
  scale: number;
  active: boolean;
  theme: ReaderTheme;
  scheduler: RenderScheduler;
  onTextInfo: (num: number, hasText: boolean) => void;
}

/**
 * A page box at its final CSS size. While active it holds a canvas (stretched to the box, so a
 * zoom or rotation shows the old bitmap scaled on the GPU until the sharp re-render lands) and a
 * text layer. pdf.js positions text-layer spans in percentages scaled by --total-scale-factor,
 * so the text layer only needs that variable updated on zoom, not a re-render.
 */
const PdfPage = forwardRef<HTMLDivElement, PageProps>(function PdfPage(
  { doc, num, width, height, scale, active, theme, scheduler, onTextInfo },
  ref,
) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const rendered = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null);
  const textDone = useRef(false);

  // canvas
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    if (!active) {
      scheduler.cancel(num);
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
    const key = `${scale.toFixed(4)}|${theme}|${dpr}`;
    if (rendered.current?.key === key) return;
    let cancelled = false;
    let renderTask: { cancel(): void; promise: Promise<unknown> } | null = null;
    scheduler.request(num, async () => {
      if (cancelled) return;
      const p = await doc.getPage(num);
      if (cancelled) return;
      const viewport = p.getViewport({ scale });
      const ratio = Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.className = 'pdf-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      renderTask = p.render({
        canvas,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
        // with pageColors, pdf.js maps the white page to `background` and ink to `foreground`
        ...(PAGE_COLORS[theme] ? { pageColors: PAGE_COLORS[theme] } : { background: '#ffffff' }),
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
      const old = rendered.current?.canvas;
      box.prepend(canvas);
      if (old) {
        old.width = 0;
        old.remove();
      }
      rendered.current = { key, canvas };
    });
    return () => {
      cancelled = true;
      scheduler.cancel(num);
      renderTask?.cancel();
    };
  }, [active, scale, theme, num, doc, scheduler]);

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
    (async () => {
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
    })().catch(() => {});
    return () => {
      cancelled = true;
      layer?.cancel();
    };
  }, [active, num, doc, onTextInfo]);

  return (
    <div
      ref={(el) => {
        boxRef.current = el;
        if (typeof ref === 'function') ref(el);
        else if (ref) ref.current = el;
      }}
      className="pdf-page"
      data-page={num}
      style={{ width, height, background: PAGE_BG[theme], ['--total-scale-factor' as string]: scale, ['--scale-factor' as string]: scale }}
    >
      <div ref={textRef} className="textLayer" />
    </div>
  );
});
