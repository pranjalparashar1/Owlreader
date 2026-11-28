import type { BookPoint } from '../../types';

/** Page boxes currently in the DOM (Scroll mode keeps ~17 around the current page). */
const pageBoxes = () => [...document.querySelectorAll<HTMLElement>('.pdf-page[data-page]')];

/** The book point under a screen position (the nearest page if it falls between or beyond pages). */
export function pointAt(clientY: number, clientX = window.innerWidth / 2): BookPoint | null {
  let best: { el: HTMLElement; r: DOMRect; d: number } | null = null;
  for (const el of pageBoxes()) {
    const r = el.getBoundingClientRect();
    if (!r.height) continue;
    // horizontal distance too: in Pages mode every page sits at the same height, side by side
    const dy = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0;
    const dx = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0;
    const d = dy + dx;
    if (!best || d < best.d) best = { el, r, d };
    if (d === 0) break;
  }
  if (!best) return null;
  return { page: Number(best.el.dataset.page), y: Math.min(1, Math.max(0, (clientY - best.r.top) / best.r.height)) };
}

/** Screen y of a book point, or ±Infinity when its page isn't mounted (above / below). */
export function clientYOf(p: BookPoint): number {
  const el = document.querySelector<HTMLElement>(`.pdf-page[data-page="${p.page}"]`);
  if (el) {
    const r = el.getBoundingClientRect();
    return r.top + p.y * r.height;
  }
  const first = Number(pageBoxes()[0]?.dataset.page ?? 0);
  return p.page < first ? -Infinity : Infinity;
}

export const comparePoints = (a: BookPoint, b: BookPoint) => a.page - b.page || a.y - b.y;
