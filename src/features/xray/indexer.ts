/**
 * Whole-book X-Ray indexing: 10 pages per batch, text fetched through the reader's idle queue
 * (so it pauses while the reader scrolls and never competes with page rendering), extraction in
 * the worker, and a checkpoint to IndexedDB after every batch so progress survives app closes.
 */
import { getBookIndex, putBookIndex } from '../../db/libraryDb';
import type { BookEntity, BookIndexRecord } from '../../types';
import { extractPages } from './client';

const BATCH = 10;
/** Keep the record small: past this, terms seen on only one page are dropped. */
const MAX_ENTITIES = 6000;

export interface IndexerOptions {
  bookId: string;
  totalPages: number;
  /** Page text, fetched when the reader is idle. Rejects if the reader went away. */
  getText: (page: number) => Promise<string>;
  onProgress: (record: BookIndexRecord) => void;
}

export function startIndexing(opts: IndexerOptions): () => void {
  let stopped = false;
  (async () => {
    const saved = await getBookIndex(opts.bookId).catch(() => undefined);
    const record: BookIndexRecord =
      saved && saved.totalPages === opts.totalPages
        ? saved
        : { bookId: opts.bookId, indexedPages: 0, totalPages: opts.totalPages, entities: {}, updatedAt: Date.now() };
    opts.onProgress(record);
    while (!stopped && record.indexedPages < record.totalPages) {
      const from = record.indexedPages + 1;
      const to = Math.min(record.totalPages, from + BATCH - 1);
      const pages: Array<{ page: number; text: string }> = [];
      for (let p = from; p <= to; p++) {
        pages.push({ page: p, text: await opts.getText(p) });
        if (stopped) return;
      }
      const results = await extractPages(pages);
      if (stopped) return;
      for (const { page, entities } of results) merge(record.entities, page, entities);
      prune(record.entities);
      record.indexedPages = to;
      record.updatedAt = Date.now();
      await putBookIndex(record);
      if (stopped) return;
      opts.onProgress({ ...record });
    }
  })().catch(() => {
    /* reader closed mid-batch, or storage failed: the last checkpoint stands */
  });
  return () => {
    stopped = true;
  };
}

function merge(
  index: Record<string, BookEntity>,
  page: number,
  entities: Array<{ key: string; label: string; kind: BookEntity['kind']; sentence: string }>,
) {
  for (const e of entities) {
    const cur = index[e.key];
    if (!cur) {
      index[e.key] = { label: e.label, kind: e.kind, pages: [page], firstPage: page, firstSentence: e.sentence };
      continue;
    }
    if (cur.pages[cur.pages.length - 1] !== page) cur.pages.push(page);
    if (cur.kind === 'term' && e.kind !== 'term') cur.kind = e.kind;
  }
}

function prune(index: Record<string, BookEntity>) {
  const keys = Object.keys(index);
  if (keys.length <= MAX_ENTITIES) return;
  for (const k of keys) if (index[k].pages.length === 1 && index[k].kind === 'term') delete index[k];
}
