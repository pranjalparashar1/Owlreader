/** Owl 1.x opens PDFs only. Records from older versions may carry another format. */
export type BookFormat = 'pdf';
/** `black` is the AMOLED theme: pure #000 page and chrome. */
export type ReaderTheme = 'light' | 'sepia' | 'dark' | 'black';
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
  /**
   * Hint appended to lookups that need disambiguating ("Nvidia"). Seeded from the PDF's subject
   * or title on import; '' means the reader cleared it. Books imported before 1.6.1 have none
   * and get a seed from their title when opened.
   */
  contextTag?: string;
  /** X-Ray: the reader opted this book into whole-book indexing. */
  xrayWholeBook?: boolean;
}

export interface ReadingProgress {
  percentage: number; // 0..100 for library display
  pdfPage?: number; // 1-indexed current page
  pdfScale?: number; // Last zoom level (multiplier of fit-width; 1 = fit width)
}

export interface LookupCandidate {
  title: string;
  snippet: string; // Plain text (HTML tags stripped)
  /** The section of `title` the search matched inside, if any. */
  section?: string;
  /** Lowercased title, description and intro, scored against the page's terms to rank the list. */
  rank?: string;
}

/** Text with the search's matched words marked: [text, isMatch][] (JSON-safe for IndexedDB). */
export type MarkedText = Array<[string, boolean]>;

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
  /**
   * 'section': no article has this title, but it's covered inside a broader one. `title` is that
   * article, `section` the matching heading and snippet; `pageUrl` links to the section.
   */
  type: 'standard' | 'disambiguation' | 'not_found' | 'section';
  section?: { title: string; snippet: MarkedText };
  candidates?: LookupCandidate[];
  /** The book context the lookup was made with (results from a search depend on it). */
  context?: string;
  /** How the list was built; lists and sections from older versions are refetched. */
  v?: number;
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

/** X-Ray: what kind of thing a term names (from the NLP tagger, or 'term' from the heuristics). */
export type EntityKind = 'person' | 'place' | 'org' | 'term';

export interface PageEntity {
  label: string;
  kind: EntityKind;
  count: number;
}

export interface BookEntity {
  label: string;
  kind: EntityKind;
  pages: number[];
  firstPage: number;
  firstSentence: string;
}

/** Whole-book X-Ray index, built in idle chunks and checkpointed so it survives app closes. */
export interface BookIndexRecord {
  bookId: string;
  /** Pages 1…indexedPages are done. */
  indexedPages: number;
  totalPages: number;
  entities: Record<string, BookEntity>;
  updatedAt: number;
}

/** A point in the book: a page and how far down it (0 = top edge, 1 = bottom edge). */
export interface BookPoint {
  page: number;
  y: number;
}

/** A clipped passage, as logical coordinates only (never bitmaps). */
export interface ClipRange {
  start: BookPoint;
  end: BookPoint;
}

/** A saved clip: a few hundred bytes, re-exported on demand. */
export interface ClipRecord {
  id: string;
  bookId: string;
  startPage: number;
  startY: number;
  endPage: number;
  endY: number;
  title: string;
  previewText: string;
  createdAt: number;
}
