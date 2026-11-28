import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { BookRecord, ClipRange, ClipRecord, ReaderLocation, ReaderTheme, ReadingProgress } from '../types';
import { getBookFile, touchBook, updateProgress } from '../db/libraryDb';
import { nearbyTerms, seedContextTag } from '../lib/terms';
import { comparePoints, pointAt } from '../features/excerpt/points';
import { clearTextSelection, restoreSelectionRange, saveSelectionRange, useTextSelection } from '../hooks/useTextSelection';
import { useOrientation } from '../hooks/useOrientation';
import { usePageSelect } from '../hooks/usePageSelect';
import { prefersReducedMotion } from '../hooks/useFocusTrap';
import type { Settings } from '../lib/settings';
import LookupPill from './LookupPill';
import LookupDrawer, { type LookupRequest } from './LookupDrawer';
import ReaderSettings from './ReaderSettings';
import ChapterMenu from './ChapterMenu';
import { ErrorScreen } from './ErrorBoundary';
import type { OutlineItem, ReaderHandle } from './readerTypes';
import { BackIcon, ChevronDown, GearIcon, ScissorsIcon } from './icons';

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
// Clip & Export (1.7) loads only when used: none of it is parsed during normal reading.
const ClipOverlay = lazy(() => import('../features/excerpt/ClipOverlay'));
const ExportSheet = lazy(() => import('../features/excerpt/ExportSheet'));
const ClipsSheet = lazy(() => import('../features/excerpt/ClipsSheet'));

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
  // seeded from the PDF's subject or title at import; offered as a chip in the lookup drawer
  const contextTag = book.contextTag ?? seedContextTag(book.title);
  const pageSelect = usePageSelect(selection.block);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  /** The theme being drawn ahead of a switch: the swatch moves at once, the screen when ready. */
  const [pendingTheme, setPendingTheme] = useState<ReaderTheme | null>(null);
  const [pageTerms, setPageTerms] = useState<string[]>([]);
  /** Clip Mode: null = reading; otherwise the range to start from (null = what's on screen). */
  const [clip, setClip] = useState<{ initial: ClipRange | null } | null>(null);
  const [exportRange, setExportRange] = useState<ClipRange | null>(null);
  /** Where the Export sheet was opened from: its Adjust button goes back to (or into) Clip Mode. */
  const [exportFrom, setExportFrom] = useState<'clip' | 'selection' | 'vault'>('clip');
  const [clipsOpen, setClipsOpen] = useState(false);

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

  // ---- Clip Mode. Clipping runs in the vertical Scroll layout (so a passage can run across a
  // page break) without changing the saved Pages/Scroll setting.
  const selectionRange = (): ClipRange | null => {
    const sel = document.getSelection();
    const rects = sel && sel.rangeCount ? [...sel.getRangeAt(0).getClientRects()].filter((r) => r.height > 0) : [];
    if (!rects.length) return null;
    const first = rects[0];
    const last = rects[rects.length - 1];
    const a = pointAt(first.top + 1, first.left + first.width / 2);
    const b = pointAt(last.bottom - 1, last.left + last.width / 2);
    return a && b && comparePoints(a, b) <= 0 ? { start: a, end: b } : null;
  };
  const enterClip = (initial: ClipRange | null) => {
    setSettingsOpen(false);
    setChrome(false);
    setExportRange(null);
    setClip({ initial });
  };
  /** One tap from a text selection: the Export sheet, with the selected lines already clipped. */
  const clipSelection = async () => {
    const raw = selection.block ? pageSelect.current : selectionRange();
    clearTextSelection();
    const doc = readerRef.current?.getDocument();
    if (!raw || !doc) return enterClip(raw);
    const { lineBounds } = await import('../features/excerpt/layout');
    setExportFrom('selection');
    setExportRange(await lineBounds(doc, raw).catch(() => raw));
  };
  const saveClipRange = async (range: ClipRange) => {
    const doc = readerRef.current?.getDocument();
    if (!doc) return;
    const { saveClip } = await import('../features/excerpt/save');
    await saveClip(doc, book.id, range);
  };
  const goToClip = (c: ClipRecord) => {
    setClipsOpen(false);
    readerRef.current?.goToPage(c.startPage, Math.max(0, c.startY - 0.05));
  };
  const locationRef = useRef(location);
  locationRef.current = location;

  // ---- theme: draw the visible pages in the new theme first, then switch everything in one
  // commit inside a View Transition, so iOS crossfades two finished frames on the GPU.
  const themeSeq = useRef(0);
  const onTheme = async (theme: ReaderTheme) => {
    if (theme === settings.theme && !pendingTheme) return;
    const seq = ++themeSeq.current;
    setPendingTheme(theme);
    await readerRef.current?.prepareTheme(theme).catch(() => {});
    if (seq !== themeSeq.current) return; // tapped another swatch meanwhile
    const apply = () =>
      flushSync(() => {
        setPendingTheme(null);
        onSettings({ theme });
      });
    if (document.startViewTransition && !prefersReducedMotion()) document.startViewTransition(apply);
    else apply();
  };

  // ---- chapters for the title menu, once the PDF is open
  const docReady = !!location;
  useEffect(() => {
    if (!docReady) return;
    let alive = true;
    readerRef.current
      ?.getOutline()
      .then((o) => alive && setOutline(o))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [docReady]);

  const clipOpen = useRef(false);
  clipOpen.current = !!clip;
  const blockRef = useRef(false);
  blockRef.current = selection.block;
  const onCenterTap = useCallback(() => {
    if (clipOpen.current) return; // in Clip Mode a tap picks a paragraph
    if (blockRef.current) return clearTextSelection(); // a tap puts the page highlight away
    setChrome((c) => !c);
    setSettingsOpen(false);
    setChaptersOpen(false);
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

  const chromeShown = chrome && !clip; // Clip Mode has its own toolbar
  const barBase = 'fixed inset-x-0 z-30 border-line bg-chrome will-change-transform';

  return (
    <div
      className="h-dvh-safe relative w-full overflow-hidden"
      data-lookup-mode={mode}
      style={{ background: 'var(--reader-bg)' }}
    >
      <div className="absolute inset-0">
        <Suspense fallback={null}>
          {readerProps && <PdfReader ref={readerRef} {...readerProps} flow={clip ? 'scrolled' : settings.flow} />}
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
        style={{
          transform: chromeShown ? 'none' : 'translateY(-110%)',
          visibility: chromeShown ? 'visible' : 'hidden',
          transition: barTransition(chromeShown),
        }}
        aria-hidden={!chromeShown}
      >
        <div className="px-safe relative flex h-12 items-center justify-between">
          <button
            onClick={onBack}
            className="-ml-2 flex h-11 w-11 items-center justify-center rounded-full text-accent active:opacity-50"
            aria-label="Back to Library"
          >
            <BackIcon size={24} />
          </button>
          {outline.length ? (
            <button
              onClick={() => setChaptersOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={chaptersOpen}
              aria-label={`${book.title}. Chapters`}
              className="absolute left-1/2 flex min-w-0 -translate-x-1/2 items-center gap-1 rounded-full px-2 py-1.5 active:opacity-50"
              style={{ maxWidth: TITLE_MAX }}
            >
              <span className="min-w-0 truncate font-serif text-[16px] font-semibold">{book.title}</span>
              <ChevronDown
                size={13}
                className="shrink-0 text-muted"
                style={{ transform: chaptersOpen ? 'rotate(180deg)' : 'none', transition: 'transform 300ms var(--ease-ios)' }}
              />
            </button>
          ) : (
            <div
              className="absolute left-1/2 min-w-0 -translate-x-1/2 truncate px-2 font-serif text-[16px] font-semibold"
              style={{ maxWidth: TITLE_MAX }}
            >
              {book.title}
            </div>
          )}
          <div className="-mr-2 flex items-center">
            <button
              onClick={() => enterClip(null)}
              disabled={!location}
              aria-label="Clip passage"
              title="Clip"
              className="flex h-11 w-9 items-center justify-center rounded-full text-accent active:opacity-50 disabled:opacity-40"
            >
              <ScissorsIcon size={21} />
            </button>
            <button
              onClick={() => setSettingsOpen((o) => !o)}
              aria-label="Reading settings"
              aria-expanded={settingsOpen}
              className="flex h-11 w-9 items-center justify-center rounded-full text-accent active:opacity-50"
            >
              <GearIcon
                size={22}
                style={{ transform: settingsOpen ? 'rotate(60deg)' : 'none', transition: 'transform 500ms var(--spring)' }}
              />
            </button>
          </div>
        </div>
      </header>

      {/* bottom bar */}
      <footer
        className={`${barBase} pb-safe bottom-0 border-t`}
        style={{
          transform: chromeShown ? 'none' : 'translateY(110%)',
          visibility: chromeShown ? 'visible' : 'hidden',
          transition: barTransition(chromeShown),
        }}
        aria-hidden={!chromeShown}
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

      {selection.any && !lookupReq && !clip && !exportRange && (
        <LookupPill
          text={mode === 'native' ? '' : selection.text}
          orientation={orientation}
          lift={chrome ? 76 : 0}
          onLookup={openLookup}
          onClip={clipSelection}
        />
      )}
      <ReaderSettings
        open={settingsOpen}
        settings={settings}
        zoom={location?.zoom ?? 1}
        onSettings={onSettings}
        onTheme={onTheme}
        pendingTheme={pendingTheme}
        onZoom={(dir) => readerRef.current?.zoom(dir)}
        onClose={() => setSettingsOpen(false)}
        onClips={() => {
          setSettingsOpen(false);
          setClipsOpen(true);
        }}
      />
      {chaptersOpen && outline.length > 0 && (
        <ChapterMenu
          items={outline}
          page={location?.page ?? 1}
          onClose={() => setChaptersOpen(false)}
          onPick={(n) => {
            setChaptersOpen(false);
            readerRef.current?.goToPage(n);
          }}
        />
      )}
      <Suspense fallback={null}>
        {clip && (
          <ClipOverlay
            reader={readerRef}
            initial={clip.initial}
            onCancel={() => setClip(null)}
            onSave={saveClipRange}
            onExport={(r) => {
              setExportFrom('clip');
              setExportRange(r);
            }}
          />
        )}
        {clipsOpen && (
          <ClipsSheet
            book={book}
            doc={readerRef.current?.getDocument() ?? null}
            onClose={() => setClipsOpen(false)}
            onGo={goToClip}
            onExport={(r) => {
              setClipsOpen(false);
              setExportFrom('vault');
              setExportRange(r);
            }}
          />
        )}
        {exportRange && readerRef.current?.getDocument() && (
          <ExportSheet
            book={book}
            range={exportRange}
            doc={readerRef.current.getDocument()!}
            theme={settings.theme}
            onClose={() => setExportRange(null)}
            onAdjust={() => (clip && exportFrom === 'clip' ? setExportRange(null) : enterClip(exportRange))}
            onSave={exportFrom === 'clip' || exportFrom === 'vault' ? undefined : saveClipRange}
          />
        )}
      </Suspense>
      <LookupDrawer
        request={lookupReq}
        orientation={orientation}
        onClose={closeLookup}
        contextTag={contextTag.trim() || undefined}
        pageTerms={pageTerms}
      />
    </div>
  );
}

// Slide on the compositor; flip visibility only after sliding out so a hidden bar
// isn't composited on every frame of scrolling underneath it.
/** Centred on the screen like an iOS navigation title, clear of the buttons on either side. */
const TITLE_MAX = 'calc(100vw - 2 * (max(16px, env(safe-area-inset-right)) + 104px))';

const barTransition = (shown: boolean) =>
  shown ? 'transform 380ms var(--ease-ios), visibility 0s' : 'transform 260ms var(--ease-ios), visibility 0s linear 260ms';

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
