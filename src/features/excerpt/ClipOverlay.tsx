/**
 * Clip Mode: a two-handle curtain over the (virtualized) Scroll view. Only logical coordinates
 * ({ page, y }) are stored; the overlay re-reads page box positions each frame while Clip Mode is
 * open, so the reader can scroll freely across page boundaries and the handles stay put on the text.
 * Tapping a paragraph (or heading) snaps the curtain to it, and tapping another stretches it to
 * cover both; the handles stay for fine-tuning. This whole module loads only when Clip Mode is entered.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReaderHandle } from '../../components/readerTypes';
import type { BookPoint, ClipRange } from '../../types';
import { MAX_CLIP_PAGES, pageLayout, paragraphAt, snapY, spanLabel } from './layout';
import { clientYOf, comparePoints, pointAt } from './points';

interface Props {
  reader: React.RefObject<ReaderHandle | null>;
  /** Start from this range (a text selection), or from the visible part of the page when null. */
  initial: ClipRange | null;
  onCancel: () => void;
  onExport: (range: ClipRange) => void;
  onSave: (range: ClipRange) => Promise<void>;
}

const EDGE = 64; // px from the scroller's edge where a dragged handle starts auto-scrolling

export default function ClipOverlay({ reader, initial, onCancel, onExport, onSave }: Props) {
  const [range, setRange] = useState<ClipRange | null>(initial);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const [saved, setSaved] = useState(false);
  const tintRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ which: 'start' | 'end'; y: number; downY: number } | null>(null);
  /** The opening on-screen guess is replaced by the first tapped paragraph rather than stretched. */
  const provisional = useRef(!initial);
  const [taps, setTaps] = useState(0);

  const scroller = () => document.querySelector<HTMLElement>('.pdf-scroller');

  const snap = useCallback(
    async (p: BookPoint, which: 'start' | 'end'): Promise<BookPoint> => {
      const doc = reader.current?.getDocument();
      if (!doc) return p;
      try {
        const layout = await pageLayout(doc, p.page);
        const y = snapY(layout, p.y);
        const first = layout.lines[0];
        const last = layout.lines[layout.lines.length - 1];
        // an end above a page's first line (or a start below its last) would add an empty page
        if (which === 'end' && first && p.page > 1 && y <= first.top) return { page: p.page - 1, y: 1 };
        if (which === 'start' && last && p.page < doc.numPages && y >= last.bottom) return { page: p.page + 1, y: 0 };
        return { page: p.page, y };
      } catch {
        return p;
      }
    },
    [reader],
  );

  // first range: the selection (brought into view), or 15%–85% of what's on screen
  useEffect(() => {
    let raf = 0;
    let tries = 0;
    const init = async () => {
      const sc = scroller();
      if (initial) {
        reader.current?.goToPage(initial.start.page, Math.max(0, initial.start.y - 0.08));
        return;
      }
      if (!sc || !document.querySelector('.pdf-page canvas')) {
        if (tries++ < 120) raf = requestAnimationFrame(init);
        return;
      }
      const r = sc.getBoundingClientRect();
      const a = pointAt(r.top + r.height * 0.15);
      const b = pointAt(r.top + r.height * 0.85);
      if (!a || !b) return;
      setRange({ start: await snap(a, 'start'), end: await snap(b, 'end') });
    };
    // two frames: let the switch to Scroll layout land before measuring
    raf = requestAnimationFrame(() => (raf = requestAnimationFrame(init)));
    return () => cancelAnimationFrame(raf);
  }, [initial, reader, snap]);

  // ---- per-frame placement (Clip Mode only): handles and tint follow the pages as they scroll
  useEffect(() => {
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const r = rangeRef.current;
      const sc = scroller();
      if (!r || !sc) return;
      const box = sc.getBoundingClientRect();
      const page = document.querySelector<HTMLElement>('.pdf-page')?.getBoundingClientRect();
      const ys = clientYOf(r.start);
      const ye = clientYOf(r.end);
      const top = Math.max(box.top, Math.min(box.bottom, ys));
      const bottom = Math.max(box.top, Math.min(box.bottom, ye));
      const tint = tintRef.current;
      if (tint) {
        tint.style.transform = `translateY(${top}px)`;
        tint.style.height = `${Math.max(0, bottom - top)}px`;
        if (page) {
          tint.style.left = `${page.left}px`;
          tint.style.width = `${page.width}px`;
        }
      }
      place(startRef.current, ys, box, r.start.page);
      place(endRef.current, ye, box, r.end.page);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---- tap-to-snap: a tap on a page picks the paragraph under it (passive listener, no preventDefault)
  useEffect(() => {
    const onClick = async (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t?.closest('.pdf-page') || t.closest('.clip-handle, [role="toolbar"]') || drag.current) return;
      const sel = document.getSelection();
      if (sel && !sel.isCollapsed) return;
      const doc = reader.current?.getDocument();
      const p = pointAt(e.clientY, e.clientX);
      if (!doc || !p) return;
      const para = await pageLayout(doc, p.page)
        .then((l) => paragraphAt(l, p.y))
        .catch(() => null);
      if (!para) return;
      const tapped: ClipRange = { start: { page: p.page, y: para.top }, end: { page: p.page, y: para.bottom } };
      const cur = rangeRef.current;
      let next = tapped;
      if (cur && !provisional.current) {
        const inside = comparePoints(tapped.start, cur.start) >= 0 && comparePoints(tapped.end, cur.end) <= 0;
        if (!inside) {
          // stretch to cover both, unless that would pass the page limit (then start over here)
          const start = comparePoints(tapped.start, cur.start) < 0 ? tapped.start : cur.start;
          const end = comparePoints(tapped.end, cur.end) > 0 ? tapped.end : cur.end;
          if (end.page - start.page < MAX_CLIP_PAGES) next = { start, end };
        }
      }
      provisional.current = false;
      setRange(next);
      setTaps((n) => n + 1);
    };
    window.addEventListener('click', onClick, { passive: true });
    return () => window.removeEventListener('click', onClick);
  }, [reader]);

  // ---- dragging a handle (pointer capture on the knob only; the page itself scrolls as usual)
  const autoScroll = useRef(0);
  useEffect(() => () => cancelAnimationFrame(autoScroll.current), []);
  const moveTo = (which: 'start' | 'end', clientY: number) => {
    const p = pointAt(clientY);
    const r = rangeRef.current;
    if (!p || !r) return;
    let next: ClipRange = which === 'start' ? { start: p, end: r.end } : { start: r.start, end: p };
    // handles can't cross, and a clip spans at most MAX_CLIP_PAGES pages
    if (comparePoints(next.start, next.end) > 0)
      next = which === 'start' ? { start: r.end, end: r.end } : { start: r.start, end: r.start };
    if (next.end.page - next.start.page >= MAX_CLIP_PAGES) {
      if (which === 'end') next = { start: next.start, end: { page: next.start.page + MAX_CLIP_PAGES - 1, y: 1 } };
      else next = { start: { page: next.end.page - MAX_CLIP_PAGES + 1, y: 0 }, end: next.end };
    }
    setRange(next);
  };
  const tick = () => {
    const d = drag.current;
    const sc = scroller();
    if (!d || !sc) return;
    const box = sc.getBoundingClientRect();
    // a knob parked at the edge (its text is scrolled away) mustn't scroll the page the moment it's touched
    const moved = Math.abs(d.y - d.downY) > 12;
    const speed = !moved
      ? 0
      : d.y < box.top + EDGE
        ? -(box.top + EDGE - d.y) / 3
        : d.y > box.bottom - EDGE
          ? (d.y - box.bottom + EDGE) / 3
          : 0;
    if (speed) {
      sc.scrollBy(0, speed);
      moveTo(d.which, d.y);
    }
    autoScroll.current = requestAnimationFrame(tick);
  };
  const onDown = (which: 'start' | 'end') => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { which, y: e.clientY, downY: e.clientY };
    provisional.current = false;
    cancelAnimationFrame(autoScroll.current);
    autoScroll.current = requestAnimationFrame(tick);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.y = e.clientY;
    moveTo(d.which, e.clientY);
  };
  const onUp = async () => {
    const d = drag.current;
    drag.current = null;
    cancelAnimationFrame(autoScroll.current);
    const r = rangeRef.current;
    if (!d || !r) return;
    setTaps((n) => n + 1);
    const snapped = await snap(d.which === 'start' ? r.start : r.end, d.which);
    setRange((cur) => (cur ? (d.which === 'start' ? { ...cur, start: snapped } : { ...cur, end: snapped }) : cur));
  };
  const nudge = (which: 'start' | 'end', dir: 1 | -1) => {
    const r = rangeRef.current;
    if (!r) return;
    const y = clientYOf(which === 'start' ? r.start : r.end);
    if (Number.isFinite(y)) moveTo(which, y + dir * 24);
  };

  const knob = (which: 'start' | 'end') => (
    <div
      ref={which === 'start' ? startRef : endRef}
      className="clip-handle"
      data-handle={which}
      style={{ transform: 'translateY(-200px)' }}
    >
      <div className="clip-line" />
      <button
        type="button"
        className="clip-knob"
        aria-label={which === 'start' ? 'Clip start' : 'Clip end'}
        onPointerDown={onDown(which)}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            nudge(which, e.key === 'ArrowUp' ? -1 : 1);
          }
        }}
        onKeyUp={(e) => (e.key === 'ArrowUp' || e.key === 'ArrowDown') && onUp()}
        onFocus={() => (drag.current = null)}
      >
        <span aria-hidden>{which === 'start' ? '▲' : '▼'}</span>
      </button>
      <span className="clip-tag" aria-hidden />
    </div>
  );

  return (
    <>
      <div className="pointer-events-none fixed inset-0 z-[36]" aria-hidden={!range}>
        <div ref={tintRef} className="clip-tint" />
        <div className="pointer-events-auto">
          {knob('start')}
          {knob('end')}
        </div>
      </div>
      <div
        role="toolbar"
        aria-label="Clip passage"
        className="pb-safe fixed inset-x-0 bottom-0 z-[38] border-t border-line bg-chrome"
      >
        <div className="px-safe flex items-center gap-2 py-2.5">
          <button type="button" onClick={onCancel} className="rounded-full px-3 py-2 text-[15px] active:bg-surface-2">
            Cancel
          </button>
          <div className="min-w-0 flex-1 text-center">
            <div className="text-[15px] font-semibold tabular-nums" data-testid="clip-span">
              {range ? spanLabel(range) : '…'}
            </div>
            <div className="text-[11px] text-muted" data-testid="clip-hint">
              {taps === 0 && !initial ? 'Tap a paragraph to start' : `Tap to extend · drag to fine-tune`}
            </div>
          </div>
          <button
            type="button"
            disabled={!range || saved}
            onClick={async () => {
              if (!range) return;
              await onSave(range);
              setSaved(true);
              window.setTimeout(() => setSaved(false), 1600);
            }}
            className="rounded-full px-3 py-2 text-[15px] font-medium active:bg-surface-2 disabled:opacity-60"
          >
            {saved ? 'Saved' : 'Save'}
          </button>
          <button
            type="button"
            disabled={!range}
            onClick={() => range && onExport(range)}
            className="rounded-full bg-fg px-4 py-2 text-[15px] font-semibold text-bg disabled:opacity-50"
          >
            Export…
          </button>
        </div>
      </div>
    </>
  );
}

/** Pin a handle to its point, or to the edge with "↑ p. N" when the point is scrolled away. */
function place(el: HTMLDivElement | null, y: number, box: DOMRect, page: number) {
  if (!el) return;
  const off = y < box.top ? 'above' : y > box.bottom ? 'below' : '';
  const clamped = Math.max(box.top + 2, Math.min(box.bottom - 2, y));
  el.style.transform = `translateY(${clamped}px)`;
  el.dataset.off = off;
  const tag = el.querySelector('.clip-tag');
  if (tag) tag.textContent = off ? `${off === 'above' ? '↑' : '↓'} p. ${page}` : '';
}
