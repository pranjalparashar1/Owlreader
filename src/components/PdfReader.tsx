import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { pdfjs, type PDFDocumentProxy } from '../lib/pdfjs';
import { localFlag } from '../lib/settings';
import { tapZone, type ReaderHandle, type ReaderProps } from './readerTypes';
import { CloseIcon } from './icons';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;
const SIDE_PAD = 8; // px of breathing room around the page at fit-width
const MAX_CANVAS_PIXELS = 16_000_000; // iOS Safari refuses larger canvases

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/**
 * Single-page PDF view: canvas rendered at devicePixelRatio plus PDF.js's TextLayer laid
 * 1:1 on top, so native iOS touch-and-drag selection works. Zoom is a multiplier of the
 * fit-to-width scale, so rotating the phone keeps the same page and relative zoom.
 */
const PdfReader = forwardRef<ReaderHandle, ReaderProps>(function PdfReader(props, ref) {
  const { book, data, theme } = props;
  const propsRef = useRef(props);
  propsRef.current = props;

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(() => Math.max(1, book.progress.pdfPage ?? 1));
  const [zoom, setZoom] = useState(() => clampZoom(book.progress.pdfScale ?? 1));
  const [width, setWidth] = useState(0);
  const [pageSize, setPageSize] = useState<{ w: number; h: number } | null>(null);
  const [scanned, setScanned] = useState(false);
  const scanKey = `owl.scanBanner.${book.id}`;
  const [bannerDismissed, setBannerDismissed] = useState(() => localFlag(scanKey)[0]);
  const pinchScale = useRef(1);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const numPages = doc?.numPages ?? 0;
  const pageRefState = useRef(page);
  pageRefState.current = page;

  // ---- load document
  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) });
    task.promise.then(
      (d) => {
        if (cancelled) return void d.destroy();
        loaded = d;
        setPage((p) => Math.min(p, d.numPages));
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

  // ---- track available width (rotation / resize)
  useEffect(() => {
    const el = scrollRef.current!;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(el.clientWidth));
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  // ---- render current page
  useEffect(() => {
    if (!doc || !width) return;
    let cancelled = false;
    let renderTask: { cancel(): void; promise: Promise<unknown> } | null = null;
    let textLayer: InstanceType<typeof pdfjs.TextLayer> | null = null;
    const scroller = scrollRef.current!;
    const scrollRatio = scroller.scrollHeight > scroller.clientHeight ? scroller.scrollTop / scroller.scrollHeight : 0;

    (async () => {
      const p = await doc.getPage(page);
      if (cancelled) return;
      const base = p.getViewport({ scale: 1 });
      const fit = (width - SIDE_PAD * 2) / base.width;
      const scale = fit * zoom;
      const viewport = p.getViewport({ scale });
      const cssW = Math.floor(viewport.width);
      const cssH = Math.floor(viewport.height);

      const dpr = window.devicePixelRatio || 1;
      const ratio = Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.cssText = `position:absolute;inset:0;width:${cssW}px;height:${cssH}px`;
      canvas.setAttribute('aria-hidden', 'true');

      const textContent = await p.getTextContent();
      if (cancelled) return;
      const hasText = textContent.items.some((it) => 'str' in it && /\S/.test(it.str));
      setScanned(!hasText);

      renderTask = p.render({
        canvas,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
        background: '#ffffff',
      });
      try {
        await renderTask.promise;
      } catch {
        return; // cancelled
      }
      if (cancelled) return;

      // swap in atomically so rotation/zoom never flashes a blank page
      const pageEl = pageRef.current!;
      pageEl.querySelector('canvas')?.remove();
      pageEl.prepend(canvas);
      pageEl.style.width = `${cssW}px`;
      pageEl.style.height = `${cssH}px`;
      pageEl.style.transform = '';
      pinchScale.current = 1;
      setPageSize({ w: cssW, h: cssH });

      const tl = textLayerRef.current!;
      tl.replaceChildren();
      tl.style.setProperty('--scale-factor', String(scale));
      tl.style.setProperty('--total-scale-factor', String(scale));
      textLayer = new pdfjs.TextLayer({ textContentSource: textContent, container: tl, viewport });
      await textLayer.render().catch(() => {});
      const end = document.createElement('div');
      end.className = 'endOfContent';
      tl.append(end);

      scroller.scrollTop = scrollRatio * scroller.scrollHeight;
    })().catch((e) => console.error(e));

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [doc, page, zoom, width]);

  // ---- report progress (single funnel)
  useEffect(() => {
    if (!numPages) return;
    const fraction = numPages > 1 ? (page - 1) / (numPages - 1) : 1;
    propsRef.current.onLocation({ fraction, page, pageCount: numPages, label: `Page ${page} of ${numPages}` });
    propsRef.current.onProgressChange({
      pdfPage: page,
      pdfScale: zoom,
      percentage: Math.round((page / numPages) * 1000) / 10,
    });
  }, [page, zoom, numPages]);

  const goToPage = useCallback(
    (n: number) => {
      if (!numPages) return;
      const next = Math.min(numPages, Math.max(1, Math.round(n)));
      if (next === pageRefState.current) return;
      setPage(next);
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    },
    [numPages],
  );
  const next = useCallback(() => {
    propsRef.current.onPageTurn();
    goToPage(pageRefState.current + 1);
  }, [goToPage]);
  const prev = useCallback(() => {
    propsRef.current.onPageTurn();
    goToPage(pageRefState.current - 1);
  }, [goToPage]);

  useImperativeHandle(
    ref,
    () => ({
      goToFraction: (f) => goToPage(1 + f * (numPages - 1)),
      goToPage,
      next,
      prev,
      zoom: (dir) => setZoom((z) => (dir === 0 ? 1 : clampZoom(dir > 0 ? z * ZOOM_STEP : z / ZOOM_STEP))),
    }),
    [goToPage, next, prev, numPages],
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

  // ---- touch: horizontal swipe to turn pages, two-finger pinch to zoom
  useEffect(() => {
    const el = scrollRef.current!;
    let start: { x: number; y: number; t: number } | null = null;
    let pinch: { dist: number } | null = null;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const hasSelection = () => {
      const s = document.getSelection();
      return !!s && !s.isCollapsed;
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        pinch = { dist: dist(e.touches) };
        start = null;
      } else if (e.touches.length === 1) {
        const t = e.touches[0];
        start = { x: t.clientX, y: t.clientY, t: Date.now() };
      }
    };
    const onMove = (e: TouchEvent) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const s = Math.min(MAX_ZOOM / zoomRef.current, Math.max(MIN_ZOOM / zoomRef.current, dist(e.touches) / pinch.dist));
        pinchScale.current = s;
        const pageEl = pageRef.current;
        if (pageEl) {
          pageEl.style.transformOrigin = 'top center';
          pageEl.style.transform = `scale(${s})`;
        }
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (pinch) {
        if (e.touches.length < 2) {
          const s = pinchScale.current;
          pinch = null;
          if (Math.abs(s - 1) > 0.04) setZoom((z) => clampZoom(z * s));
          else if (pageRef.current) pageRef.current.style.transform = '';
        }
        return;
      }
      if (!start) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      const dt = Date.now() - start.t;
      start = null;
      const fitsWidth = el.scrollWidth <= el.clientWidth + 2;
      if (fitsWidth && dt < 700 && Math.abs(dx) > 60 && Math.abs(dy) < Math.abs(dx) * 0.6 && !hasSelection()) {
        if (dx < 0) next();
        else prev();
      }
    };
    // iOS Safari: stop the browser's own page zoom so the UI chrome doesn't scale
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
  }, [next, prev]);

  // ---- tap zones
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
    const rect = scrollRef.current!.getBoundingClientRect();
    const zone = tapZone(e.clientX - rect.left, rect.width);
    if (zone === 'center') props.onCenterTap();
    else if (zone === 'next') next();
    else prev();
  };

  const canvasFilter = theme === 'dark' ? 'pdf-dark' : theme === 'sepia' ? 'pdf-sepia' : '';

  return (
    <div className="relative h-full w-full" style={{ background: 'var(--reader-bg)' }}>
      <div
        ref={scrollRef}
        onClick={onClick}
        className="h-full w-full overflow-auto overscroll-contain"
        style={{ touchAction: 'pan-x pan-y', WebkitOverflowScrolling: 'touch' }}
      >
        <div
          className="flex min-h-full items-start justify-center"
          style={{
            padding: `calc(${SIDE_PAD}px + env(safe-area-inset-top)) ${SIDE_PAD}px calc(${SIDE_PAD}px + env(safe-area-inset-bottom))`,
            minWidth: pageSize ? pageSize.w + SIDE_PAD * 2 : undefined,
          }}
        >
          <div
            ref={pageRef}
            className={`pdf-page relative shrink-0 bg-white shadow-[0_1px_3px_rgb(0_0_0/0.2)] ${canvasFilter}`}
            style={{ width: pageSize?.w, height: pageSize?.h }}
            data-page={page}
          >
            <div ref={textLayerRef} className="textLayer" />
          </div>
        </div>
      </div>

      {!doc && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      )}

      {scanned && !bannerDismissed && (
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
