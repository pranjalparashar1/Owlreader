import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { BookIndexRecord, BookRecord, ReaderLocation, ReadingProgress } from '../types';
import { getBookFile, getBookIndex, touchBook, updateBook, updateProgress } from '../db/libraryDb';
import { nearbyTerms, seedContextTag } from '../lib/terms';
import { findEntity } from '../features/xray/find';
import { clearTextSelection, restoreSelectionRange, saveSelectionRange, useTextSelection } from '../hooks/useTextSelection';
import { useOrientation } from '../hooks/useOrientation';
import type { Settings } from '../lib/settings';
import LookupPill from './LookupPill';
import LookupDrawer, { type LookupRequest } from './LookupDrawer';
import ReaderSettings, { type XrayState } from './ReaderSettings';
import { ErrorScreen } from './ErrorBoundary';
import type { ReaderHandle } from './readerTypes';
import { BackIcon, CloseIcon, FitWidthIcon, ReturnIcon, XrayIcon } from './icons';

interface Props {
  book: BookRecord;
  settings: Settings;
  onSettings: (patch: Partial<Settings>) => void;
  onBack: () => void;
}
const SAVE_DEBOUNCE_MS = 600;
const THUMB_W = 160; // scrubber preview render width in px (~0.04 MP)
const THUMB_THROTTLE_MS = 70;
const CARD_W = 132; // preview card width in CSS px

// PDF.js is ~450 kB: keep it out of the library screen's first load.
const PdfReader = lazy(() => import('./PdfReader'));

export default function ReaderShell({ book, settings, onSettings, onBack }: Props) {
  const [file, setFile] = useState<{ data: ArrayBuffer; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chrome, setChrome] = useState(true);
  const [location, setLocation] = useState<ReaderLocation | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [lookupReq, setLookupReq] = useState<LookupRequest | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const readerRef = useRef<ReaderHandle>(null);
  const orientation = useOrientation();
  const selection = useTextSelection();
  const [contextTag, setContextTag] = useState(() => book.contextTag ?? seedContextTag(book.title));
  const [pageTerms, setPageTerms] = useState<string[]>([]);
  const [wholeBook, setWholeBook] = useState(!!book.xrayWholeBook);
  const [bookIndex, setBookIndex] = useState<BookIndexRecord | null>(null);
  const [returnTo, setReturnTo] = useState<number | null>(null);
  const [xrayBusy, setXrayBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    touchBook(book.id).catch(() => {});
    getBookFile(book.id)
      .then((f) => {
        if (!alive) return;
        if (f) setFile({ data: f.data, name: f.name });
        else setError('The file for this book is missing. Try importing it again.');
      })
      .catch(() => alive && setError("Couldn't read this book from storage."));
    return () => {
      alive = false;
    };
  }, [book.id]);

  // ---- the single progress funnel: debounce writes, flush when the app is backgrounded
  const pending = useRef<ReadingProgress | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const p = pending.current;
    pending.current = null;
    if (p) updateProgress(book.id, p).catch(() => {});
  }, [book.id]);
  const onProgressChange = useCallback(
    (p: ReadingProgress) => {
      pending.current = { ...(pending.current ?? book.progress), ...p };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    [book.progress, flush],
  );
  useEffect(() => {
    const onHide = () => document.visibilityState === 'hidden' && flush();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [flush]);

  const onLocation = useCallback((loc: ReaderLocation) => setLocation(loc), []);
  const locationRef = useRef(location);
  locationRef.current = location;

  // ---- book context: saved shortly after the reader stops typing
  const ctxTimer = useRef<number | undefined>(undefined);
  const onContextTag = (tag: string) => {
    setContextTag(tag);
    window.clearTimeout(ctxTimer.current);
    ctxTimer.current = window.setTimeout(() => updateBook(book.id, { contextTag: tag.trim() }).catch(() => {}), 400);
  };
  useEffect(() => () => window.clearTimeout(ctxTimer.current), []);

  // ---- X-Ray. Off = nothing below runs. Whole book = index in idle chunks (lazily loaded).
  const xrayOn = settings.xray === 'on';
  const xrayState: XrayState = !xrayOn ? 'off' : wholeBook ? 'book' : 'page';
  const onXray = (s: XrayState) => {
    if (s !== 'off' && !xrayOn) onSettings({ xray: 'on' });
    if (s === 'off') onSettings({ xray: 'off' });
    const wb = s === 'book' ? true : s === 'page' ? false : wholeBook;
    if (wb !== wholeBook) {
      setWholeBook(wb);
      updateBook(book.id, { xrayWholeBook: wb }).catch(() => {});
    }
  };
  // an index built earlier still answers "In This Book" in This Page mode
  useEffect(() => {
    if (!xrayOn) return;
    let alive = true;
    getBookIndex(book.id)
      .then((r) => alive && r && setBookIndex(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [book.id, xrayOn]);
  const pageCountKnown = location?.pageCount ?? 0;
  useEffect(() => {
    if (!xrayOn || !wholeBook || !pageCountKnown) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    import('../features/xray/indexer').then(({ startIndexing }) => {
      if (cancelled) return;
      stop = startIndexing({
        bookId: book.id,
        totalPages: pageCountKnown,
        getText: (n) => readerRef.current?.getPageText(n, { idle: true }) ?? Promise.reject(new Error('closed')),
        onProgress: setBookIndex,
      });
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [book.id, xrayOn, wholeBook, pageCountKnown]);
  const inBook = useCallback((term: string) => (xrayOn ? findEntity(bookIndex, term) : undefined), [xrayOn, bookIndex]);

  const openXray = async () => {
    const page = locationRef.current?.page ?? 1;
    setXrayBusy(true);
    try {
      const text = (await readerRef.current?.getPageText(page)) ?? '';
      const { extractPage } = await import('../features/xray/client');
      const entities = await extractPage(text);
      setPageTerms([]);
      setLookupReq((r) => ({ query: '', id: (r?.id ?? 0) + 1, xray: { page, entities } }));
    } catch {
      setLookupReq((r) => ({ query: '', id: (r?.id ?? 0) + 1, xray: { page, entities: [] } }));
    } finally {
      setXrayBusy(false);
    }
  };

  // ---- jump from an "In This Book" card, with a way back
  const onJump = (page: number) => {
    const from = locationRef.current?.page;
    setReturnTo((r) => r ?? from ?? null);
    closeLookup();
    readerRef.current?.goToPage(page);
  };
  const goBack = () => {
    if (returnTo !== null) readerRef.current?.goToPage(returnTo);
    setReturnTo(null);
  };
  const onCenterTap = useCallback(() => {
    setChrome((c) => !c);
    setSettingsOpen(false);
  }, []);
  const onPageTurn = useCallback(() => setChrome(false), []);

  // Lookup modes: 'wiki' = pill, tapping it clears the selection and opens the drawer.
  // 'native' = no pill and we never touch the selection, so iOS's own Copy | Look Up |
  // Translate bar is all there is. 'both' = pill too, and the selection comes back when the
  // drawer closes so iOS's Look Up is still one tap away.
  const mode = settings.lookupMode;
  const savedRange = useRef<Range | null>(null);
  const openLookup = (text: string) => {
    savedRange.current = mode === 'both' ? saveSelectionRange() : null;
    // the page the words are on (in Scroll mode it may not be the "current" one)
    const node = document.getSelection()?.anchorNode;
    const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
    const onPage = Number(el?.closest<HTMLElement>('.pdf-page')?.dataset.page) || locationRef.current?.page || 1;
    clearTextSelection(); // the drawer covers the words; iOS's bar would float over it
    setPageTerms([]);
    setLookupReq((r) => ({ query: text, id: (r?.id ?? 0) + 1 }));
    // context chips: capitalised terms near the selection (pdf.js text is already parsed: fast)
    readerRef.current
      ?.getPageText(onPage)
      .then((t) => setPageTerms(nearbyTerms(t, text, [contextTag])))
      .catch(() => {});
  };
  const closeLookup = useCallback(() => {
    setLookupReq(null);
    const r = savedRange.current;
    savedRange.current = null;
    if (r) requestAnimationFrame(() => restoreSelectionRange(r));
  }, []);

  const readerProps = file && {
    book,
    data: file.data,
    fileName: file.name,
    theme: settings.theme,
    onProgressChange,
    onLocation,
    onCenterTap,
    onPageTurn,
    onError: setError,
  };

  const pageCount = location?.pageCount ?? 0;
  const scrubValue = scrub ?? location?.page ?? 1;
  const scrubMax = Math.max(1, pageCount);
  const fill = scrubMax > 1 ? ((scrubValue - 1) / (scrubMax - 1)) * 100 : 0;
  const scrubLabel = scrub !== null ? `Page ${scrub} of ${pageCount}` : (location?.label ?? '');

  // ---- live scrubber preview: throttled micro-thumbnail of the page under the thumb. Only the
  // newest request may paint; the reader cancels superseded renders, so fast drags never queue.
  const scrubRef = useRef<number | null>(null);
  scrubRef.current = scrub;
  const thumbHost = useRef<HTMLDivElement>(null);
  const thumbSeq = useRef(0);
  const thumbTimer = useRef<number | undefined>(undefined);
  const lastThumbAt = useRef(0);
  const wantThumb = useRef(1);
  const fireThumb = useCallback(() => {
    thumbTimer.current = undefined;
    lastThumbAt.current = performance.now();
    const n = wantThumb.current;
    const seq = ++thumbSeq.current;
    readerRef.current?.renderThumbnail(n, THUMB_W).then((c) => {
      if (seq !== thumbSeq.current || !c || scrubRef.current === null) return;
      thumbHost.current?.replaceChildren(c);
      thumbHost.current?.setAttribute('data-page', String(n));
    });
  }, []);
  const onScrubInput = (n: number) => {
    if (scrubRef.current === null) thumbHost.current?.replaceChildren(); // new drag: no stale page
    setScrub(n);
    wantThumb.current = n;
    const wait = THUMB_THROTTLE_MS - (performance.now() - lastThumbAt.current);
    if (wait <= 0) fireThumb();
    else thumbTimer.current ??= window.setTimeout(fireThumb, wait);
  };
  const commitScrub = () => {
    const target = scrubRef.current;
    if (target === null) return;
    window.clearTimeout(thumbTimer.current);
    thumbTimer.current = undefined;
    thumbSeq.current++; // late thumbnails must not repaint the closed card
    scrubRef.current = null;
    setScrub(null);
    readerRef.current?.goToPage(target);
  };
  useEffect(() => () => window.clearTimeout(thumbTimer.current), []);

  const barBase = 'fixed inset-x-0 z-30 border-line bg-chrome will-change-transform';

  return (
    <div
      className="h-dvh-safe relative w-full overflow-hidden"
      data-lookup-mode={mode}
      style={{ background: 'var(--reader-bg)' }}
    >
      <div className="absolute inset-0">
        <Suspense fallback={null}>{readerProps && <PdfReader ref={readerRef} {...readerProps} flow={settings.flow} />}</Suspense>
      </div>

      {error && (
        <div className="absolute inset-0 z-[60]">
          <ErrorScreen title="Couldn't open this book" message={error} onBack={onBack} />
        </div>
      )}

      {/* solid band under the status bar so iOS's edge blur has nothing to smear */}
      <div className="status-shield" style={{ background: 'var(--reader-bg)' }} aria-hidden />

      {/* top bar */}
      <header
        className={`${barBase} pt-safe-bar top-0 border-b`}
        style={{
          transform: chrome ? 'none' : 'translateY(-110%)',
          visibility: chrome ? 'visible' : 'hidden',
          transition: barTransition(chrome),
        }}
        aria-hidden={!chrome}
      >
        <div className="px-safe flex h-12 items-center gap-2">
          <button
            onClick={onBack}
            className="-ml-2 flex items-center gap-0.5 rounded-full py-2 pr-3 pl-1 text-[15px] active:bg-surface-2"
            aria-label="Back to Library"
          >
            <BackIcon size={22} /> <span className="hidden sm:inline">Library</span>
          </button>
          <div className="min-w-0 flex-1 truncate text-center font-serif text-[15px] font-semibold">{book.title}</div>
          {xrayOn && (
            <button
              onClick={openXray}
              disabled={xrayBusy || !location}
              aria-label="X-Ray this page"
              title="X-Ray"
              className="flex h-9 items-center gap-1 rounded-full px-2.5 text-[13px] font-semibold active:bg-surface-2 disabled:opacity-60"
            >
              <XrayIcon size={19} />
              <span className="hidden sm:inline">X-Ray</span>
            </button>
          )}
          <button
            onClick={() => setSettingsOpen((o) => !o)}
            aria-label="Reading settings"
            aria-expanded={settingsOpen}
            className={`flex h-9 items-center gap-1 rounded-full px-3 font-serif text-[17px] font-semibold ${
              settingsOpen ? 'bg-surface-2' : 'active:bg-surface-2'
            }`}
          >
            <span className="text-[13px]">A</span>A
          </button>
        </div>
      </header>

      {/* bottom bar */}
      <footer
        className={`${barBase} pb-safe bottom-0 border-t`}
        style={{
          transform: chrome ? 'none' : 'translateY(110%)',
          visibility: chrome ? 'visible' : 'hidden',
          transition: barTransition(chrome),
        }}
        aria-hidden={!chrome}
      >
        <div className="px-safe pt-2 pb-2">
          <div className="relative flex items-center gap-3">
            {/* stays mounted so the canvas host keeps its node; hidden when not scrubbing */}
            <div
              className="scrub-preview"
              aria-hidden
              style={{
                display: scrub === null ? 'none' : undefined,
                width: CARD_W,
                left: `clamp(0px, calc(10px + (100% - 20px) * ${fill / 100} - ${CARD_W / 2}px), calc(100% - ${CARD_W}px))`,
              }}
            >
              <div ref={thumbHost} className="scrub-thumb" />
              <div className="mt-1.5 text-center text-[12px] leading-tight font-semibold tabular-nums">
                Page {scrubValue} of {pageCount}
              </div>
              <div className="text-center text-[11px] text-muted tabular-nums">
                {pageCount ? Math.round((scrubValue / pageCount) * 100) : 0}%
              </div>
            </div>
            <input
              type="range"
              className="scrubber min-w-0 flex-1"
              min={1}
              max={scrubMax}
              value={scrubValue}
              disabled={!location || pageCount < 2}
              style={{ ['--fill' as string]: `${fill}%` }}
              onChange={(e) => onScrubInput(Number(e.target.value))}
              onPointerUp={commitScrub}
              onTouchEnd={commitScrub}
              onKeyUp={commitScrub}
              aria-label="Page"
              aria-valuetext={`Page ${scrubValue} of ${pageCount}`}
            />
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1 truncate text-[12px] text-muted">{scrubLabel}</div>
            <ToolButton label="Fit width" onClick={() => readerRef.current?.zoom(0)}>
              <FitWidthIcon size={18} />
            </ToolButton>
            <div className="flex items-center gap-1">
              <ToolButton label="Previous page" onClick={() => readerRef.current?.prev()}>
                <BackIcon size={18} />
              </ToolButton>
              <ToolButton label="Next page" onClick={() => readerRef.current?.next()}>
                <BackIcon size={18} className="rotate-180" />
              </ToolButton>
            </div>
          </div>
        </div>
      </footer>

      {returnTo !== null && !lookupReq && (
        <div
          className="fixed z-40 flex items-center rounded-full bg-fg text-bg shadow-[0_8px_28px_-6px_rgb(0_0_0/0.45)] transition-[top] duration-200"
          style={{
            left: '50%',
            transform: 'translateX(-50%)',
            top: `calc(${chrome ? 64 : 14}px + env(safe-area-inset-top) * 1.25)`,
          }}
        >
          <button onClick={goBack} className="flex items-center gap-1.5 py-2 pr-2 pl-3.5 text-[14px] font-medium">
            <ReturnIcon size={16} className="text-accent" /> Return to p. {returnTo}
          </button>
          <button onClick={() => setReturnTo(null)} className="py-2 pr-3 pl-1 opacity-70" aria-label="Dismiss return">
            <CloseIcon size={15} />
          </button>
        </div>
      )}

      {mode !== 'native' && selection.text && !lookupReq && (
        <LookupPill text={selection.text} orientation={orientation} lift={chrome ? 76 : 0} onLookup={openLookup} />
      )}
      <ReaderSettings
        open={settingsOpen}
        settings={settings}
        zoom={location?.zoom ?? 1}
        onSettings={onSettings}
        onZoom={(dir) => readerRef.current?.zoom(dir)}
        onClose={() => setSettingsOpen(false)}
        contextTag={contextTag}
        onContextTag={onContextTag}
        xray={xrayState}
        onXray={onXray}
        indexProgress={wholeBook && bookIndex ? { indexed: bookIndex.indexedPages, total: bookIndex.totalPages } : null}
      />
      <LookupDrawer
        request={lookupReq}
        orientation={orientation}
        onClose={closeLookup}
        contextTag={contextTag.trim() || undefined}
        pageTerms={pageTerms}
        inBook={xrayOn ? inBook : undefined}
        onJump={onJump}
      />
    </div>
  );
}

// Slide on the compositor; flip visibility only after sliding out so a hidden bar
// isn't composited on every frame of scrolling underneath it.
const barTransition = (shown: boolean) =>
  shown ? 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1), visibility 0s' : 'transform 200ms ease-in, visibility 0s linear 200ms';

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-9 min-w-9 items-center justify-center rounded-full px-2 text-fg active:bg-surface-2"
    >
      {children}
    </button>
  );
}
