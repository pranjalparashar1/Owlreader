/** OwlReader 1.x opens PDFs only. Records from older versions may carry another format. */
export type BookFormat = 'pdf';
export type ReaderTheme = 'light' | 'sepia' | 'dark';
export type Orientation = 'portrait' | 'landscape';

export interface BookRecord {
  id: string; // crypto.randomUUID()
  title: string;
  author?: string;
  format: BookFormat;
  fileSize: number;
  addedAt: number;
  lastOpenedAt: number;
  coverDataUrl?: string; // Optional extracted cover thumbnail
  progress: ReadingProgress;
}

export interface ReadingProgress {
  percentage: number; // 0..100 for library display
  pdfPage?: number; // 1-indexed current page
  pdfScale?: number; // Last zoom level (multiplier of fit-width; 1 = fit width)
}

export interface LookupCandidate {
  title: string;
  snippet: string; // Plain text (HTML tags stripped)
}

export interface LookupResult {
  query: string;
  title: string;
  description?: string;
  extract: string; // 2-3 sentence summary
  imageUrl?: string;
  imageIsPortrait?: boolean; // taller than wide: anchor to the top so faces aren't cropped
  pageUrl?: string;
  coordinates?: {
    lat: number;
    lon: number;
  };
  type: 'standard' | 'disambiguation' | 'not_found';
  candidates?: LookupCandidate[];
  cachedAt: number;
}

/** Location info a reader reports for the shell's scrubber. */
export interface ReaderLocation {
  fraction: number; // 0..1
  label?: string; // chapter title or "Page 3 of 120"
  page?: number;
  pageCount?: number;
  zoom?: number; // multiplier of fit-width (1 = 100%)
}

/** Books saved by older versions in a format this version can't open (read straight from IndexedDB). */
export function isSupportedBook(book: { format?: unknown }): boolean {
  return book.format === 'pdf';
}
