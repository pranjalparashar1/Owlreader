import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { BookRecord, ReaderLocation, ReadingProgress } from '../types';
import { getBookFile, touchBook, updateProgress } from '../db/libraryDb';
import { clearTextSelection, useTextSelection } from '../hooks/useTextSelection';
import { useOrientation } from '../hooks/useOrientation';
import type { Settings } from '../lib/settings';
import LookupPill from './LookupPill';
import LookupDrawer, { type LookupRequest } from './LookupDrawer';
import ReaderSettings from './ReaderSettings';
import { ErrorScreen } from './ErrorBoundary';
import type { ReaderHandle } from './readerTypes';
import { BackIcon, FitWidthIcon } from './icons';

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
  const onCenterTap = useCallback(() => {
    setChrome((c) => !c);
    setSettingsOpen(false);
  }, []);
  const onPageTurn = useCallback(() => setChrome(false), []);

  const openLookup = (text: string) => {
    clearTextSelection();
    setLookupReq((r) => ({ query: text, id: (r?.id ?? 0) + 1 }));
  };
  const closeLookup = useCallback(() => setLookupReq(null), []);

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
  const scrubLabel = scrub !== null ? `Page ${scrub} of ${pageCount}` : location?.label ?? '';

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
    <div className="h-dvh-safe relative w-full overflow-hidden" style={{ background: 'var(--reader-bg)' }}>
      <div className="absolute inset-0">
        <Suspense fallback={null}>
          {readerProps && <PdfReader ref={readerRef} {...readerProps} flow={settings.flow} />}
        </Suspense>
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
        style={{ transform: chrome ? 'none' : 'translateY(-110%)', visibility: chrome ? 'visible' : 'hidden', transition: barTransition(chrome) }}
        aria-hidden={!chrome}
      >
        <div className="px-safe flex h-12 items-center gap-2">
          <button onClick={onBack} className="-ml-2 flex items-center gap-0.5 rounded-full py-2 pr-3 pl-1 text-[15px] active:bg-surface-2" aria-label="Back to Library">
            <BackIcon size={22} /> <span className="hidden sm:inline">Library</span>
          </button>
          <div className="min-w-0 flex-1 truncate text-center font-serif text-[15px] font-semibold">{book.title}</div>
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
        style={{ transform: chrome ? 'none' : 'translateY(110%)', visibility: chrome ? 'visible' : 'hidden', transition: barTransition(chrome) }}
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

      {selection.text && !lookupReq && (
        <LookupPill text={selection.text} orientation={orientation} lift={chrome ? 76 : 0} onLookup={openLookup} />
      )}
      <ReaderSettings
        open={settingsOpen}
        settings={settings}
        zoom={location?.zoom ?? 1}
        onSettings={onSettings}
        onZoom={(dir) => readerRef.current?.zoom(dir)}
        onClose={() => setSettingsOpen(false)}
      />
      <LookupDrawer request={lookupReq} orientation={orientation} onClose={closeLookup} />
    </div>
  );
}

// Slide on the compositor; flip visibility only after sliding out so a hidden bar
// isn't composited on every frame of scrolling underneath it.
const barTransition = (shown: boolean) =>
  shown
    ? 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1), visibility 0s'
    : 'transform 200ms ease-in, visibility 0s linear 200ms';

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
