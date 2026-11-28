import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { BookRecord, ClipRecord, LookupResult, ReadingProgress } from '../types';

interface OwlDB extends DBSchema {
  books: { key: string; value: BookRecord };
  files: { key: string; value: { bookId: string; data: ArrayBuffer; name: string; type: string } };
  lookupCache: { key: string; value: LookupResult & { key: string; usedAt?: number } };
  clips: { key: string; value: ClipRecord; indexes: { bookId: string } };
}

/** Stores that hold per-book data: deleting a book clears its rows in all of them, in one transaction. */
const BOOK_STORES = ['books', 'files'] as const;

let dbPromise: Promise<IDBPDatabase<OwlDB>> | null = null;

function db() {
  // v1: books, files, lookupCache. v2 (1.6.1): bookIndex for X-Ray. v3 (1.7): clips. v4 (1.8.4): X-Ray
  // removed, so bookIndex is deleted. Books, files, saved lookups and clips are never touched.
  dbPromise ??= openDB<OwlDB>('owlreader', 4, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        d.createObjectStore('books', { keyPath: 'id' });
        d.createObjectStore('files', { keyPath: 'bookId' });
        d.createObjectStore('lookupCache', { keyPath: 'key' });
      }
      if (oldVersion < 3) d.createObjectStore('clips', { keyPath: 'id' }).createIndex('bookId', 'bookId');
      // idb's typed schema no longer knows the store, hence the cast
      if ((d.objectStoreNames as DOMStringList).contains('bookIndex'))
        (d as unknown as IDBDatabase).deleteObjectStore('bookIndex');
    },
    // another tab (or a test) holding an older connection mustn't block the upgrade forever
    blocking() {
      dbPromise?.then((d) => d.close());
      dbPromise = null;
    },
  });
  return dbPromise;
}

export async function listBooks(): Promise<BookRecord[]> {
  const books = await (await db()).getAll('books');
  return books.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export async function getBook(id: string) {
  return (await db()).get('books', id);
}

/** Stores metadata and the raw file in one transaction. ArrayBuffers are used instead of
 * Blobs because Blob storage in IndexedDB has historically been unreliable on iOS Safari. */
export async function addBook(book: BookRecord, file: { data: ArrayBuffer; name: string; type: string }) {
  const d = await db();
  const tx = d.transaction(['books', 'files'], 'readwrite');
  await Promise.all([tx.objectStore('books').put(book), tx.objectStore('files').put({ bookId: book.id, ...file }), tx.done]);
}

export async function getBookFile(bookId: string) {
  return (await db()).get('files', bookId);
}

export async function deleteBook(bookId: string) {
  const d = await db();
  const tx = d.transaction([...BOOK_STORES, 'clips'], 'readwrite');
  const clipKeys = await tx.objectStore('clips').index('bookId').getAllKeys(bookId);
  await Promise.all([
    ...BOOK_STORES.map((s) => tx.objectStore(s).delete(bookId)),
    ...clipKeys.map((k) => tx.objectStore('clips').delete(k)),
    tx.done,
  ]);
}

export async function listClips(bookId: string): Promise<ClipRecord[]> {
  const clips = await (await db()).getAllFromIndex('clips', 'bookId', bookId);
  return clips.sort((a, b) => b.createdAt - a.createdAt);
}

export async function putClip(clip: ClipRecord) {
  await (await db()).put('clips', clip);
}

export async function deleteClip(id: string) {
  await (await db()).delete('clips', id);
}

export async function updateProgress(bookId: string, progress: ReadingProgress) {
  const d = await db();
  const tx = d.transaction('books', 'readwrite');
  const book = await tx.store.get(bookId);
  if (book) await tx.store.put({ ...book, progress: { ...book.progress, ...progress } });
  await tx.done;
}

export async function touchBook(bookId: string) {
  const d = await db();
  const tx = d.transaction('books', 'readwrite');
  const book = await tx.store.get(bookId);
  if (book) await tx.store.put({ ...book, lastOpenedAt: Date.now() });
  await tx.done;
}

/** Most lookups kept; the least recently used go first. */
export const LOOKUP_CACHE_MAX = 500;

export async function getCachedLookup(key: string): Promise<LookupResult | undefined> {
  const d = await db();
  const hit = await d.get('lookupCache', key);
  if (!hit) return undefined;
  // mark as used for the LRU cap (best effort, doesn't block the lookup)
  d.put('lookupCache', { ...hit, usedAt: Date.now() }).catch(() => {});
  const { key: _k, usedAt: _u, ...result } = hit;
  return result;
}

export async function putCachedLookup(key: string, result: LookupResult) {
  const d = await db();
  await d.put('lookupCache', { ...result, key, usedAt: Date.now() });
  if ((await d.count('lookupCache')) > LOOKUP_CACHE_MAX) await pruneLookups(d);
}

async function pruneLookups(d: IDBPDatabase<OwlDB>) {
  const tx = d.transaction('lookupCache', 'readwrite');
  const all: Array<[string, number]> = [];
  for (let c = await tx.store.openCursor(); c; c = await c.continue()) all.push([c.key, c.value.usedAt ?? c.value.cachedAt ?? 0]);
  all.sort((a, b) => a[1] - b[1]);
  await Promise.all(all.slice(0, all.length - LOOKUP_CACHE_MAX).map(([k]) => tx.store.delete(k)));
  await tx.done;
}

export async function storageCounts(): Promise<{ books: number; lookups: number }> {
  const d = await db();
  const [books, lookups] = await Promise.all([d.count('books'), d.count('lookupCache')]);
  return { books, lookups };
}

/** Frees the space used by saved Wikipedia lookups (and their cached photos). Books are untouched. */
export async function clearLookupCache() {
  await (await db()).clear('lookupCache');
  if ('caches' in window) {
    for (const name of await caches.keys()) if (name.startsWith('wiki-images')) await caches.delete(name);
  }
}

let persistRequested = false;
/** Ask the browser to keep our storage (reduces iOS Safari eviction risk). */
export function requestPersistentStorage() {
  if (persistRequested) return;
  persistRequested = true;
  navigator.storage?.persist?.().catch(() => {});
}
