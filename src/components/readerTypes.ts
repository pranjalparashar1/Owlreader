import type { BookRecord, ReaderLocation, ReaderTheme, ReadingProgress } from '../types';

export interface ReaderHandle {
  goToPage(page: number): void; // 1-indexed
  next(): void;
  prev(): void;
  zoom(dir: 1 | -1 | 0): void; // 0 = fit width
  /** Tiny render of a page for the scrubber preview; null if superseded or failed. */
  renderThumbnail(page: number, widthPx: number): Promise<HTMLCanvasElement | null>;
  /**
   * A page's text from pdf.js. `idle` waits for the reader's idle queue (after visible pages have
   * rendered, never mid-scroll): for background work like whole-book X-Ray indexing.
   */
  getPageText(page: number, opts?: { idle?: boolean }): Promise<string>;
}

export interface ReaderProps {
  book: BookRecord;
  data: ArrayBuffer;
  fileName: string;
  theme: ReaderTheme;
  /** Single funnel for position updates (saved to IndexedDB by the shell). */
  onProgressChange: (p: ReadingProgress) => void;
  onLocation: (loc: ReaderLocation) => void;
  onCenterTap: () => void;
  onPageTurn: () => void;
  onError: (message: string) => void;
}

/** Which third of the reading area was tapped. */
export function tapZone(x: number, width: number): 'prev' | 'center' | 'next' {
  const f = x / width;
  if (f < 0.28) return 'prev';
  if (f > 0.72) return 'next';
  return 'center';
}
