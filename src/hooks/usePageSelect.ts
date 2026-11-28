import { useEffect, useRef } from 'react';
import type { ClipRange } from '../types';
import { comparePoints, pointAt } from '../features/excerpt/points';
import { setBlockSelection } from './useTextSelection';

const HOLD_MS = 350; // a press at least this long, without moving, is a long-press
const MOVE_PX = 10;
/** A long-press that selects at least this share of a page's text grabbed "the whole page". */
const PAGE_SHARE = 0.5;
const MIN_PAGE_CHARS = 120;

/**
 * Long-pressing a zoomed-out page makes iOS select all of it, paint it system blue and float
 * its Copy | Look Up | Translate bar over the middle of the page, where nothing else can be
 * tapped. When that happens, the native selection is swapped for Owl's own highlight (accent
 * tint, one rounded bar per line) and the Clip pill. Normal word and passage selections are
 * left to iOS. The selection is read at touchend, before iOS shows its bar.
 *
 * Returns a ref holding the highlighted range, for Clip.
 */
export function usePageSelect(block: boolean) {
  const range = useRef<ClipRange | null>(null);

  useEffect(() => {
    let start: { x: number; y: number; t: number } | null = null;
    let moved = false;
    const inReader = (e: TouchEvent) => !!(e.target as Element | null)?.closest?.('.pdf-scroller');
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || !inReader(e)) return (start = null);
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY, t: performance.now() };
      moved = false;
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (start && t && Math.hypot(t.clientX - start.x, t.clientY - start.y) > MOVE_PX) moved = true;
    };
    const onEnd = () => {
      const s = start;
      start = null;
      if (!s || moved || performance.now() - s.t < HOLD_MS) return;
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const r = sel.getRangeAt(0);
      const node = r.startContainer;
      const pageEl = (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest<HTMLElement>('.pdf-page');
      const total = pageEl?.querySelector('.textLayer')?.textContent?.length ?? 0;
      if (!pageEl || total < MIN_PAGE_CHARS || sel.toString().length < total * PAGE_SHARE) return;
      const rects = [...r.getClientRects()].filter((x) => x.width > 0.5 && x.height > 0.5);
      if (!rects.length) return;
      const a = pointAt(rects[0].top + 1, rects[0].left + rects[0].width / 2);
      const last = rects[rects.length - 1];
      const b = pointAt(last.bottom - 1, last.left + last.width / 2);
      range.current = a && b && comparePoints(a, b) <= 0 ? { start: a, end: b } : null;
      paint(rects);
      sel.removeAllRanges();
      setBlockSelection();
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };
  }, []);

  useEffect(() => {
    if (block) return;
    range.current = null;
    for (const el of document.querySelectorAll('.page-select')) el.remove();
  }, [block]);

  return range;
}

/** One rounded bar per line, in % of the page so a zoom or rotation keeps it in place. */
function paint(rects: DOMRect[]) {
  for (const el of document.querySelectorAll('.page-select')) el.remove();
  const pages = [...document.querySelectorAll<HTMLElement>('.pdf-page[data-page]')].map((el) => ({
    el,
    r: el.getBoundingClientRect(),
    lines: [] as Array<{ top: number; bottom: number; left: number; right: number }>,
  }));
  for (const x of rects) {
    const cx = x.left + x.width / 2;
    const cy = x.top + x.height / 2;
    const p = pages.find(({ r }) => cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom);
    if (!p) continue;
    // same line: vertical overlap of more than half the shorter box
    const line = p.lines.find(
      (l) => Math.min(l.bottom, x.bottom) - Math.max(l.top, x.top) > Math.min(l.bottom - l.top, x.height) / 2,
    );
    if (line) {
      line.top = Math.min(line.top, x.top);
      line.bottom = Math.max(line.bottom, x.bottom);
      line.left = Math.min(line.left, x.left);
      line.right = Math.max(line.right, x.right);
    } else p.lines.push({ top: x.top, bottom: x.bottom, left: x.left, right: x.right });
  }
  for (const { el, r, lines } of pages) {
    if (!lines.length) continue;
    const host = document.createElement('div');
    host.className = 'page-select';
    host.setAttribute('aria-hidden', 'true');
    for (const l of lines) {
      const bar = document.createElement('div');
      const pad = 1.5;
      bar.style.left = `${((l.left - pad - r.left) / r.width) * 100}%`;
      bar.style.top = `${((l.top - pad - r.top) / r.height) * 100}%`;
      bar.style.width = `${((l.right - l.left + pad * 2) / r.width) * 100}%`;
      bar.style.height = `${((l.bottom - l.top + pad * 2) / r.height) * 100}%`;
      host.append(bar);
    }
    el.append(host);
  }
}
