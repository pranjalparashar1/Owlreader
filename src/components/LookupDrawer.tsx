import { useEffect, useRef, useState } from 'react';
import type { Orientation } from '../types';
import { lookup, normalizeQuery, OfflineError, type LookupResponse } from '../services/wikipedia';
import LookupCard from './LookupCard';
import { BackIcon, CloseIcon, SearchIcon } from './icons';

export interface LookupRequest {
  query: string;
  id: number; // bump to re-run the same query
}

interface Props {
  request: LookupRequest | null;
  orientation: Orientation;
  onClose: () => void;
}

type View =
  | { status: 'loading'; query: string }
  | { status: 'done'; response: LookupResponse }
  | { status: 'error'; query: string; message: string; offline: boolean };

const ANIM_MS = 260;
const SWIPE_CLOSE_PX = 90;
const FLICK_MS = 160; // how far a release "throws" the sheet, in ms of current velocity

/**
 * Side-sheet in landscape (book stays visible on the left), bottom-sheet in portrait.
 * Takes a plain query request, so any source (text selection today, an X-Ray list later)
 * can drive it.
 */
export default function LookupDrawer({ request, orientation, onClose }: Props) {
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

  async function run(query: string, opts: { exactTitle?: boolean; push?: boolean } = {}) {
    const id = ++runId.current;
    const loading: View = { status: 'loading', query };
    setStack((s) => (opts.push ? [...s, loading] : [loading]));
    let next: View;
    try {
      next = { status: 'done', response: await lookup(query, opts) };
    } catch (e) {
      const offline = e instanceof OfflineError;
      next = {
        status: 'error',
        query,
        offline,
        message: offline ? "You're offline, and this hasn't been looked up before." : 'Lookup failed. Please try again.',
      };
    }
    if (id !== runId.current) return;
    setStack((s) => [...s.slice(0, -1), next]);
    scrollRef.current?.scrollTo({ top: 0 });
  }

  useEffect(() => {
    if (!request) return;
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
    if (q) run(q);
    (document.activeElement as HTMLElement | null)?.blur();
  };

  return (
    <div className="fixed inset-0 z-50" aria-hidden={!open}>
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
              <SearchIcon size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                enterKeyHint="search"
                autoCapitalize="words"
                autoCorrect="off"
                spellCheck={false}
                aria-label="Refine lookup"
                className="h-10 w-full rounded-full bg-surface-2 pr-3 pl-9 text-[16px] outline-none ring-accent/50 focus:ring-2"
              />
            </form>
            <button onClick={onClose} className="rounded-full bg-surface-2 p-2 text-fg active:opacity-70" aria-label="Close lookup">
              <CloseIcon size={18} />
            </button>
          </div>
        </div>

        <div ref={scrollRef} className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${landscape ? '' : 'pb-safe'}`}>
          {current?.status === 'loading' && <Skeleton compact={!landscape} />}
          {current?.status === 'error' && (
            <div className="px-5 py-8 text-center">
              <p className="text-[15px] font-medium">{current.message}</p>
              <button
                onClick={() => run(current.query)}
                className="mt-4 rounded-full bg-fg px-4 py-2 text-[14px] font-semibold text-bg"
              >
                Try again
              </button>
            </div>
          )}
          {current?.status === 'done' && (
            <LookupCard
              result={current.response.result}
              fromCache={current.response.fromCache}
              compact={!landscape}
              onMapOpen={() => setDetent('full')}
              onPickCandidate={(title) => {
                setInput(title);
                run(title, { exactTitle: true, push: true });
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
