import { useEffect, useRef, useState } from 'react';
import type { BookEntity, Orientation, PageEntity } from '../types';
import { lookup, normalizeQuery, OfflineError, ServiceError, type LookupResponse } from '../services/wikipedia';
import LookupCard from './LookupCard';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { BackIcon, CloseIcon, PlusIcon, SearchIcon, XrayIcon } from './icons';

export interface LookupRequest {
  query: string;
  id: number; // bump to re-run the same query
  /** Open on X-Ray's "On This Page" list instead of a lookup. */
  xray?: { page: number; entities: PageEntity[] };
}

interface Props {
  request: LookupRequest | null;
  orientation: Orientation;
  onClose: () => void;
  /** The book's context hint ("Nvidia"): offered as a chip and used to boost searches. */
  contextTag?: string;
  /** Capitalised terms near the selection on its page, offered as one-tap chips. */
  pageTerms?: string[];
  /** X-Ray whole-book index lookup, when the book has one. */
  inBook?: (term: string) => BookEntity | undefined;
  /** Jump to a page from an "In This Book" card. */
  onJump?: (page: number) => void;
}

/** `term` is what the reader originally looked up (before chips or candidates), for "In This Book". */
type View =
  | { status: 'xray'; page: number; entities: PageEntity[] }
  | { status: 'loading'; query: string; term: string }
  | { status: 'done'; query: string; term: string; exactTitle?: boolean; response: LookupResponse }
  | { status: 'error'; query: string; term: string; exactTitle?: boolean; message: string; detail?: string };

type RunOpts = { exactTitle?: boolean; push?: boolean; retry?: boolean; refresh?: boolean; term?: string };

const ANIM_MS = 260;
const SWIPE_CLOSE_PX = 90;
const FLICK_MS = 160; // how far a release "throws" the sheet, in ms of current velocity

/**
 * Side-sheet in landscape (book stays visible on the left), bottom-sheet in portrait.
 * Takes a plain query request, so any source (text selection today, an X-Ray list later)
 * can drive it.
 */
export default function LookupDrawer({ request, orientation, onClose, contextTag, pageTerms, inBook, onJump }: Props) {
  const open = request !== null;
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const [input, setInput] = useState('');
  const [stack, setStack] = useState<View[]>([]);
  const [detent, setDetent] = useState<'half' | 'full'>('half');
  const runId = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const landscape = orientation === 'landscape';
  const detentRef = useRef(detent);
  detentRef.current = detent;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const current = stack[stack.length - 1];

  // mount → next frame slide in; close → slide out → unmount
  useEffect(() => {
    if (open) {
      setMounted(true);
      const r = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(r);
    }
    setShown(false);
    const t = window.setTimeout(() => {
      setMounted(false);
      setStack([]);
      setDetent('half');
    }, ANIM_MS);
    return () => window.clearTimeout(t);
  }, [open]);

  async function run(query: string, opts: RunOpts = {}) {
    const id = ++runId.current;
    const term = opts.term ?? query;
    const loading: View = { status: 'loading', query, term };
    setStack((s) => (opts.push ? [...s, loading] : opts.retry || opts.refresh ? [...s.slice(0, -1), loading] : [loading]));
    let next: View;
    try {
      const response = await lookup(query, { exactTitle: opts.exactTitle, refresh: opts.refresh, context: contextTag });
      next = { status: 'done', query, term, exactTitle: opts.exactTitle, response };
    } catch (e) {
      next = {
        status: 'error',
        query,
        term,
        exactTitle: opts.exactTitle,
        ...(e instanceof OfflineError
          ? { message: "You're offline, and this hasn't been looked up before." }
          : e instanceof ServiceError
            ? {
                message: e.message,
                detail: e.reason === 'timeout' ? 'Check your connection and try again.' : 'Give it a moment and try again.',
              }
            : { message: 'Lookup failed. Please try again.' }),
      };
    }
    if (id !== runId.current) return;
    setStack((s) => [...s.slice(0, -1), next]);
    scrollRef.current?.scrollTo({ top: 0 });
  }

  useEffect(() => {
    if (!request) return;
    if (request.xray) {
      runId.current++;
      setInput('');
      setStack([{ status: 'xray', ...request.xray }]);
      return;
    }
    setInput(normalizeQuery(request.query) || request.query);
    run(request.query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // ---- drag: portrait = up to full screen / down to half / down to close; landscape = swipe right to close
  useEffect(() => {
    const sheet = sheetRef.current;
    const header = headerRef.current;
    const content = scrollRef.current;
    if (!mounted || !sheet || !header || !content) return;

    let start: { x: number; y: number; t: number; base: number; fromHeader: boolean } | null = null;
    let dragging = false;
    let last = { y: 0, t: 0, v: 0 };

    const halfOffset = () => Math.max(0, sheet.offsetHeight - window.innerHeight * 0.5);
    const currentBase = () => (landscape ? 0 : detentRef.current === 'full' ? 0 : halfOffset());

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY, t: e.timeStamp, base: currentBase(), fromHeader: header.contains(e.target as Node) };
      dragging = false;
      last = { y: landscape ? t.clientX : t.clientY, t: e.timeStamp, v: 0 };
    };
    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const t = e.touches[0];
      const d = landscape ? t.clientX - start.x : t.clientY - start.y;
      const cross = landscape ? t.clientY - start.y : t.clientX - start.x;
      if (!dragging) {
        // A finger tap drifts a few px; a 6px threshold turned taps on a meaning into tiny
        // drags (preventDefault cancels the click). Require a clear, mostly-vertical move.
        if (Math.abs(d) < 12) {
          if (Math.abs(cross) >= 12) start = null;
          return;
        }
        if (Math.abs(cross) * 1.5 > Math.abs(d)) return (start = null);
        if (landscape) {
          if (!start.fromHeader || d < 0) return (start = null);
        } else if (!start.fromHeader) {
          const atTop = content.scrollTop <= 0;
          // At the half detent the content can't scroll yet: dragging up expands the sheet
          // (like iOS sheets). At full height, only pull down from the very top.
          const expandFromHalf = detentRef.current === 'half';
          if (!(expandFromHalf || (atTop && d > 0))) return (start = null);
        }
        dragging = true;
        sheet.style.transition = 'none';
      }
      e.preventDefault();
      const pos = landscape ? t.clientX : t.clientY;
      const dt = Math.max(1, e.timeStamp - last.t);
      last = { y: pos, t: e.timeStamp, v: (pos - last.y) / dt };
      let off = start.base + d;
      if (off < 0) off = off / 4; // rubber-band past full height
      sheet.style.transform = landscape ? `translateX(${Math.max(0, off)}px)` : `translateY(${off}px)`;
    };
    const onEnd = () => {
      if (!start) return;
      const s = start;
      start = null;
      if (!dragging) return;
      dragging = false;
      const rect = sheet.getBoundingClientRect();
      const off = landscape ? rect.left - (window.innerWidth - rect.width) : rect.top - (window.innerHeight - rect.height);
      const projected = off + last.v * FLICK_MS;
      sheet.style.transition = '';
      sheet.style.transform = '';
      if (landscape) {
        if (projected > SWIPE_CLOSE_PX) onCloseRef.current();
        return;
      }
      const half = halfOffset();
      const fromHalf = s.base > 0;
      // a flick steps one detent at a time: full -> half, half -> closed
      if (fromHalf && (projected > half + SWIPE_CLOSE_PX || (projected > half + 40 && last.v > 0.5))) onCloseRef.current();
      else setDetent(projected < half / 2 ? 'full' : 'half');
    };

    sheet.addEventListener('touchstart', onStart, { passive: true });
    sheet.addEventListener('touchmove', onMove, { passive: false });
    sheet.addEventListener('touchend', onEnd);
    sheet.addEventListener('touchcancel', onEnd);
    return () => {
      sheet.removeEventListener('touchstart', onStart);
      sheet.removeEventListener('touchmove', onMove);
      sheet.removeEventListener('touchend', onEnd);
      sheet.removeEventListener('touchcancel', onEnd);
    };
  }, [mounted, landscape]);

  useFocusTrap(sheetRef, mounted && open);

  if (!mounted) return null;

  // Portrait: the sheet is full height and sits translated down to a half-screen detent.
  // Moving it is a pure GPU transform (no height/layout animation).
  const transform = !shown
    ? landscape
      ? 'translateX(105%)'
      : 'translateY(105%)'
    : landscape || detent === 'full'
      ? 'none'
      : 'translateY(calc(100% - 50dvh))';

  const sheetStyle: React.CSSProperties = landscape
    ? {
        top: 0,
        right: 0,
        bottom: 0,
        width: '40vw',
        minWidth: 300,
        maxWidth: 420,
        height: '100dvh',
        paddingTop: 'env(safe-area-inset-top)',
        paddingRight: 'env(safe-area-inset-right)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }
    : { left: 0, right: 0, bottom: 0, height: 'calc(100dvh - env(safe-area-inset-top) - 12px)' };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = input.trim();
    // from the X-Ray list, a search opens on top of it so Back returns to the list
    if (q) run(q, { push: current?.status === 'xray' });
    (document.activeElement as HTMLElement | null)?.blur();
  };

  // one-tap refinements: the book's context, then terms near the selection on its page
  const chips: string[] = [];
  if (current && current.status !== 'xray' && input.trim()) {
    for (const t of [contextTag ?? '', ...(pageTerms ?? [])]) {
      const l = t.trim().toLowerCase();
      if (l && !input.toLowerCase().includes(l) && !chips.some((c) => c.toLowerCase() === l)) chips.push(t.trim());
    }
  }
  const addChip = (t: string) => {
    const q = `${input.trim()} ${t}`;
    setInput(q);
    run(q, { term: current && current.status !== 'xray' ? current.term : undefined });
  };
  const entity = current && current.status !== 'xray' ? inBook?.(current.term) : undefined;

  return (
    <div className="fixed inset-0 z-50" aria-hidden={!open} inert={!open}>
      <div
        className="absolute inset-0 bg-black transition-opacity"
        style={{ opacity: shown ? (landscape ? 0.18 : 0.3) : 0, transitionDuration: `${ANIM_MS}ms` }}
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Lookup"
        className={`absolute flex flex-col overflow-hidden bg-surface text-fg shadow-[0_0_40px_rgb(0_0_0/0.3)] ${
          landscape ? 'border-l border-line' : 'rounded-t-[20px]'
        }`}
        ref={sheetRef}
        style={{
          ...sheetStyle,
          transform,
          transition: `transform ${ANIM_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`,
          willChange: 'transform',
        }}
      >
        <div ref={headerRef} className="shrink-0 touch-none">
          {!landscape && (
            <button
              type="button"
              onClick={() => setDetent((d) => (d === 'half' ? 'full' : 'half'))}
              className="flex w-full justify-center pt-2 pb-1"
              aria-label={detent === 'half' ? 'Expand lookup' : 'Shrink lookup'}
            >
              <span className="h-1.5 w-10 rounded-full bg-line" />
            </button>
          )}
          <div className={`flex items-center gap-2 px-3 ${landscape ? 'pt-3' : 'pt-1'} pb-2`}>
            {stack.length > 1 && (
              <button
                onClick={() => {
                  runId.current++;
                  setStack((s) => s.slice(0, -1));
                }}
                className="rounded-full p-2 text-muted active:bg-surface-2"
                aria-label="Back to results"
              >
                <BackIcon size={20} />
              </button>
            )}
            <form onSubmit={submit} className="relative min-w-0 flex-1" role="search">
              <SearchIcon size={17} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg/70" />
              <input
                ref={inputRef}
                type="search"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                enterKeyHint="search"
                autoCapitalize="words"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Search Wikipedia"
                aria-label="Search Wikipedia"
                className="lookup-search h-10 w-full rounded-full border border-line bg-bg pr-9 pl-9 text-[16px] shadow-[inset_0_1px_2px_rgb(0_0_0/0.06)] outline-none placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/30"
              />
              {input && (
                <button
                  type="button"
                  onClick={() => {
                    setInput('');
                    inputRef.current?.focus();
                  }}
                  className="absolute top-1/2 right-1.5 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-muted active:bg-surface-2"
                  aria-label="Clear search"
                >
                  <CloseIcon size={15} strokeWidth={2.2} />
                </button>
              )}
            </form>
            <button
              onClick={onClose}
              className="rounded-full bg-surface-2 p-2 text-fg active:opacity-70"
              aria-label="Close lookup"
            >
              <CloseIcon size={18} />
            </button>
          </div>
          {chips.length > 0 && (
            <div className="no-scrollbar flex gap-1.5 overflow-x-auto px-3 pb-2" role="group" aria-label="Add context">
              {chips.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => addChip(c)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-[13px] font-medium ring-1 ring-line active:bg-line"
                  aria-label={`Add ${c} to the search`}
                >
                  <PlusIcon size={13} strokeWidth={2.4} className="text-accent" />
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>

        <div ref={scrollRef} className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${landscape ? '' : 'pb-safe'}`}>
          {current?.status === 'xray' && (
            <XrayList
              page={current.page}
              entities={current.entities}
              inBook={inBook}
              onPick={(label) => {
                setInput(label);
                run(label, { push: true, term: label });
              }}
            />
          )}
          {entity && onJump && <InThisBook entity={entity} onJump={onJump} />}
          {entity && current?.status !== 'xray' && (
            <div className="px-5 pt-3 text-[11px] font-semibold tracking-wider text-muted uppercase">Wikipedia</div>
          )}
          {current?.status === 'loading' && <Skeleton compact={!landscape} />}
          {current?.status === 'error' && (
            <div className="px-5 py-8 text-center">
              <p className="text-[15px] font-medium">{current.message}</p>
              {current.detail && <p className="mt-1 text-[13px] text-muted">{current.detail}</p>}
              <button
                onClick={() => run(current.query, { exactTitle: current.exactTitle, retry: true, term: current.term })}
                className="mt-4 rounded-full bg-fg px-4 py-2 text-[14px] font-semibold text-bg"
              >
                Retry
              </button>
            </div>
          )}
          {current?.status === 'done' && (
            <LookupCard
              result={current.response.result}
              fromCache={current.response.fromCache}
              compact={!landscape || !!entity}
              contextTag={contextTag}
              onMapOpen={() => setDetent('full')}
              onRefresh={() => run(current.query, { exactTitle: current.exactTitle, refresh: true, term: current.term })}
              onPickCandidate={(title) => {
                setInput(title);
                run(title, { exactTitle: true, push: true, term: current.term });
              }}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function Skeleton({ compact }: { compact: boolean }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className={`skeleton rounded-none ${compact ? 'h-[150px]' : 'h-[200px]'}`} />
      <div className="space-y-3 px-5 pt-4">
        <div className="skeleton h-6 w-2/3" />
        <div className="skeleton h-4 w-1/2" />
        <div className="skeleton mt-4 h-4 w-full" />
        <div className="skeleton h-4 w-full" />
        <div className="skeleton h-4 w-4/5" />
      </div>
    </div>
  );
}

const KIND_LABEL: Record<PageEntity['kind'], string> = { person: 'Person', place: 'Place', org: 'Organisation', term: 'Term' };
const KIND_DOT: Record<PageEntity['kind'], string> = {
  person: 'bg-sky-500',
  place: 'bg-emerald-500',
  org: 'bg-violet-500',
  term: 'bg-amber-500',
};

/** X-Ray's "On This Page" list: names and terms extracted from the current page. */
function XrayList({
  page,
  entities,
  inBook,
  onPick,
}: {
  page: number;
  entities: PageEntity[];
  inBook?: (term: string) => BookEntity | undefined;
  onPick: (label: string) => void;
}) {
  return (
    <div className="px-4 pt-2 pb-5">
      <h2 className="flex items-center gap-2 px-1 text-[15px] font-semibold">
        <XrayIcon size={17} className="text-accent" /> On This Page
        <span className="font-normal text-muted">· p. {page}</span>
      </h2>
      {entities.length === 0 ? (
        <p className="mt-3 px-1 text-[14px] text-muted">No names or terms found on this page.</p>
      ) : (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="On this page">
          {entities.map((e) => {
            const pages = inBook?.(e.label)?.pages.length;
            return (
              <li key={e.label}>
                <button
                  type="button"
                  onClick={() => onPick(e.label)}
                  className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 text-[14px] font-medium ring-1 ring-line active:bg-line"
                  aria-label={`${e.label}, ${KIND_LABEL[e.kind]}${pages ? `, on ${pages} pages` : ''}`}
                >
                  <span className={`h-2 w-2 rounded-full ${KIND_DOT[e.kind]}`} aria-hidden />
                  {e.label}
                  {pages ? <span className="text-[12px] font-normal text-muted tabular-nums">{pages}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-4 px-1 text-[12px] text-muted">Found on this device from the page's text. Tap one to look it up.</p>
    </div>
  );
}

const MAX_PILLS = 24;

/** X-Ray whole-book card: where the book first mentions a term, and every page it appears on. */
function InThisBook({ entity, onJump }: { entity: BookEntity; onJump: (page: number) => void }) {
  const [all, setAll] = useState(false);
  const pages = all ? entity.pages : entity.pages.slice(0, MAX_PILLS);
  return (
    <section aria-label="In this book" className="mx-4 mt-2 rounded-2xl bg-surface-2 p-4 ring-1 ring-line">
      <div className="text-[11px] font-semibold tracking-wider text-muted uppercase">In this book</div>
      {entity.firstSentence && (
        <p className="mt-1.5 font-serif text-[15px] leading-relaxed">
          <span className="text-muted">First mentioned on p. {entity.firstPage}: </span>“{entity.firstSentence}”
        </p>
      )}
      <div className="mt-2 text-[12px] text-muted">
        {entity.pages.length === 1 ? 'Mentioned on 1 page' : `Mentioned on ${entity.pages.length} pages`}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {pages.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onJump(p)}
            className="rounded-full bg-surface px-2.5 py-1 text-[12.5px] font-medium tabular-nums ring-1 ring-line active:bg-line"
            aria-label={`Go to page ${p}`}
          >
            p. {p}
          </button>
        ))}
        {!all && entity.pages.length > MAX_PILLS && (
          <button type="button" onClick={() => setAll(true)} className="rounded-full px-2.5 py-1 text-[12.5px] text-muted">
            +{entity.pages.length - MAX_PILLS} more
          </button>
        )}
      </div>
    </section>
  );
}
