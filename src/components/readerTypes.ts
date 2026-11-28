import type { BookRecord, ReaderLocation, ReaderTheme, ReadingProgress } from '../types';
import type { PDFDocumentProxy } from '../lib/pdfjs';

export interface ReaderHandle {
  /** 1-indexed. `frac` (Scroll mode) lands that far down the page instead of at its top. */
  goToPage(page: number, frac?: number): void;
  next(): void;
  prev(): void;
  zoom(dir: 1 | -1 | 0): void; // 0 = fit the text column to the screen
  /** Tiny render of a page for the scrubber preview; null if superseded or failed. */
  renderThumbnail(page: number, widthPx: number): Promise<HTMLCanvasElement | null>;
  /** A page's text from pdf.js (for the lookup's context chips). */
  getPageText(page: number): Promise<string>;
  /** The open pdf.js document, for on-demand tools (Clip & Export). */
  getDocument(): PDFDocumentProxy | null;
  /** The PDF's chapters (its outline), flattened; [] when it has none. */
  getOutline(): Promise<OutlineItem[]>;
  /** Draws the visible pages in `theme` ahead of a theme change, so it can swap in at once. */
  prepareTheme(theme: ReaderTheme): Promise<void>;
}

export interface OutlineItem {
  title: string;
  /** 1-indexed */
  page: number;
  /** 0 = chapter, 1 = section */
  depth: number;
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
