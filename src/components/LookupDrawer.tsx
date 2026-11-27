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
  const [drag, setDrag] = useState(0);
  const runId = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  const landscape = orientation === 'landscape';
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

  if (!mounted) return null;

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    dragStart.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (!dragStart.current) return;
    const t = e.touches[0];
    const d = landscape ? t.clientX - dragStart.current.x : t.clientY - dragStart.current.y;
    // only follow the finger when the content is scrolled to the top (portrait)
    if (!landscape && (scrollRef.current?.scrollTop ?? 0) > 0) return;
    setDrag(Math.max(0, d));
  };
  const onTouchEnd = () => {
    if (drag > SWIPE_CLOSE_PX) onClose();
    setDrag(0);
    dragStart.current = null;
  };

  const hidden = landscape ? 'translateX(105%)' : 'translateY(105%)';
  const transform = !shown ? hidden : drag ? (landscape ? `translateX(${drag}px)` : `translateY(${drag}px)`) : 'none';

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
    : { left: 0, right: 0, bottom: 0, height: '50dvh', minHeight: 280 };

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
        style={{
          ...sheetStyle,
          transform,
          transition: drag ? 'none' : `transform ${ANIM_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`,
        }}
      >
        <div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} className="shrink-0">
          {!landscape && (
            <div className="flex justify-center pt-2 pb-1">
              <div className="h-1.5 w-10 rounded-full bg-line" />
            </div>
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
