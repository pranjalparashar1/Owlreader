import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { BookRecord, ReaderLocation, ReaderTheme, ReadingProgress } from '../types';
import { getBookFile, touchBook, updateProgress } from '../db/libraryDb';
import { clearTextSelection, useTextSelection } from '../hooks/useTextSelection';
import { useOrientation } from '../hooks/useOrientation';
import type { Settings } from '../lib/settings';
import LookupPill from './LookupPill';
import LookupDrawer, { type LookupRequest } from './LookupDrawer';
import type { ReaderHandle } from './readerTypes';
import { BackIcon, FitWidthIcon, MinusIcon, PagesIcon, PlusIcon, ScrollIcon } from './icons';

interface Props {
  book: BookRecord;
  settings: Settings;
  onSettings: (patch: Partial<Settings>) => void;
  onBack: () => void;
}

const THEMES: Array<{ id: ReaderTheme; label: string; swatch: string; ink: string }> = [
  { id: 'light', label: 'Light', swatch: '#ffffff', ink: '#1c1917' },
  { id: 'sepia', label: 'Sepia', swatch: '#f4ecd8', ink: '#433422' },
  { id: 'dark', label: 'Dark', swatch: '#121212', ink: '#e7e5e4' },
];

const SAVE_DEBOUNCE_MS = 600;

// Each engine is its own chunk: PDF.js alone is ~400 kB and EPUB readers never need it.
const EpubReader = lazy(() => import('./EpubReader'));
const PdfReader = lazy(() => import('./PdfReader'));

export default function ReaderShell({ book, settings, onSettings, onBack }: Props) {
  const [file, setFile] = useState<{ data: ArrayBuffer; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chrome, setChrome] = useState(true);
  const [location, setLocation] = useState<ReaderLocation | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [lookupReq, setLookupReq] = useState<LookupRequest | null>(null);
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
  const onCenterTap = useCallback(() => setChrome((c) => !c), []);
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

  const isPdf = book.format === 'pdf';
  const pageCount = location?.pageCount ?? 0;
  const scrubValue = scrub ?? (isPdf ? location?.page ?? 1 : Math.round((location?.fraction ?? 0) * 1000));
  const scrubMax = isPdf ? Math.max(1, pageCount) : 1000;
  const scrubMin = isPdf ? 1 : 0;
  const fill = scrubMax > scrubMin ? ((scrubValue - scrubMin) / (scrubMax - scrubMin)) * 100 : 0;
  const scrubLabel =
    scrub !== null
      ? isPdf
        ? `Page ${scrub} of ${pageCount}`
        : `${(scrub / 10).toFixed(0)}%`
      : location?.label || (location ? `${Math.round(location.fraction * 100)}%` : '');

  const commitScrub = () => {
    if (scrub === null) return;
    if (isPdf) readerRef.current?.goToPage?.(scrub);
    else readerRef.current?.goToFraction(scrub / 1000);
    setScrub(null);
  };

  const barBase = 'absolute inset-x-0 z-30 border-line bg-chrome backdrop-blur-md transition-transform duration-200 ease-out';

  return (
    <div className="h-dvh-safe relative w-full overflow-hidden" style={{ background: 'var(--reader-bg)' }}>
      <div className="absolute inset-0">
        <Suspense fallback={null}>
          {readerProps &&
            (isPdf ? (
              <PdfReader ref={readerRef} {...readerProps} />
            ) : (
              <EpubReader ref={readerRef} {...readerProps} fontPct={settings.fontPct} flow={settings.epubFlow} />
            ))}
        </Suspense>
      </div>

      {error && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 p-8 text-center">
          <p className="max-w-xs text-[15px]">{error}</p>
          <button onClick={onBack} className="rounded-full bg-fg px-5 py-2.5 text-[15px] font-semibold text-bg">
            Back to Library
          </button>
        </div>
      )}

      {/* top bar */}
      <header
        className={`${barBase} pt-safe top-0 border-b`}
        style={{ transform: chrome ? 'none' : 'translateY(-110%)' }}
        aria-hidden={!chrome}
      >
        <div className="px-safe flex h-12 items-center gap-2">
          <button onClick={onBack} className="-ml-2 flex items-center gap-0.5 rounded-full py-2 pr-3 pl-1 text-[15px] active:bg-surface-2" aria-label="Back to Library">
            <BackIcon size={22} /> <span className="hidden sm:inline">Library</span>
          </button>
          <div className="min-w-0 flex-1 truncate text-center font-serif text-[15px] font-semibold">{book.title}</div>
          <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <button
                key={t.id}
                role="radio"
                aria-checked={settings.theme === t.id}
                aria-label={`${t.label} theme`}
                onClick={() => onSettings({ theme: t.id })}
                className={`flex h-8 w-8 items-center justify-center rounded-full text-[12px] font-semibold ring-1 transition ${
                  settings.theme === t.id ? 'ring-2 ring-accent' : 'ring-line'
                }`}
                style={{ background: t.swatch, color: t.ink }}
              >
                Aa
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* bottom bar */}
      <footer
        className={`${barBase} pb-safe bottom-0 border-t`}
        style={{ transform: chrome ? 'none' : 'translateY(110%)' }}
        aria-hidden={!chrome}
      >
        <div className="px-safe pt-2 pb-2">
          <div className="flex items-center gap-3">
            <input
              type="range"
              className="scrubber min-w-0 flex-1"
              min={scrubMin}
              max={scrubMax}
              value={scrubValue}
              disabled={!location || (isPdf && pageCount < 2)}
              style={{ ['--fill' as string]: `${fill}%` }}
              onChange={(e) => setScrub(Number(e.target.value))}
              onPointerUp={commitScrub}
              onTouchEnd={commitScrub}
              onKeyUp={commitScrub}
              aria-label={isPdf ? 'Page' : 'Position in book'}
            />
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1 truncate text-[12px] text-muted">{scrubLabel}</div>
            {isPdf ? (
              <div className="flex items-center gap-1">
                <ToolButton label="Zoom out" onClick={() => readerRef.current?.zoom?.(-1)}>
                  <MinusIcon size={18} />
                </ToolButton>
                <ToolButton label="Fit width" onClick={() => readerRef.current?.zoom?.(0)}>
                  <FitWidthIcon size={18} />
                </ToolButton>
                <ToolButton label="Zoom in" onClick={() => readerRef.current?.zoom?.(1)}>
                  <PlusIcon size={18} />
                </ToolButton>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <ToolButton label="Smaller text" onClick={() => onSettings({ fontPct: Math.max(70, settings.fontPct - 10) })}>
                  <span className="text-[13px] font-semibold">A−</span>
                </ToolButton>
                <ToolButton label="Larger text" onClick={() => onSettings({ fontPct: Math.min(220, settings.fontPct + 10) })}>
                  <span className="text-[17px] font-semibold">A+</span>
                </ToolButton>
                <ToolButton
                  label={settings.epubFlow === 'paginated' ? 'Switch to scrolling' : 'Switch to pages'}
                  onClick={() => onSettings({ epubFlow: settings.epubFlow === 'paginated' ? 'scrolled' : 'paginated' })}
                >
                  {settings.epubFlow === 'paginated' ? <ScrollIcon size={18} /> : <PagesIcon size={18} />}
                </ToolButton>
              </div>
            )}
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
      <LookupDrawer request={lookupReq} orientation={orientation} onClose={closeLookup} />
    </div>
  );
}

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
