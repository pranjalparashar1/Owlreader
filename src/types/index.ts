export type BookFormat = 'epub' | 'pdf';
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
  epubCfi?: string; // Exact EPUB location
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
}
