import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { BookRecord, LookupResult, ReadingProgress } from '../types';

interface OwlDB extends DBSchema {
  books: { key: string; value: BookRecord };
  files: { key: string; value: { bookId: string; data: ArrayBuffer; name: string; type: string } };
  lookupCache: { key: string; value: LookupResult & { key: string } };
}

let dbPromise: Promise<IDBPDatabase<OwlDB>> | null = null;

function db() {
  dbPromise ??= openDB<OwlDB>('owlreader', 1, {
    upgrade(d) {
      d.createObjectStore('books', { keyPath: 'id' });
      d.createObjectStore('files', { keyPath: 'bookId' });
      d.createObjectStore('lookupCache', { keyPath: 'key' });
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
  await Promise.all([
    tx.objectStore('books').put(book),
    tx.objectStore('files').put({ bookId: book.id, ...file }),
    tx.done,
  ]);
}

export async function getBookFile(bookId: string) {
  return (await db()).get('files', bookId);
}

export async function deleteBook(bookId: string) {
  const d = await db();
  const tx = d.transaction(['books', 'files'], 'readwrite');
  await Promise.all([tx.objectStore('books').delete(bookId), tx.objectStore('files').delete(bookId), tx.done]);
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

export async function getCachedLookup(key: string): Promise<LookupResult | undefined> {
  const hit = await (await db()).get('lookupCache', key);
  if (!hit) return undefined;
  const { key: _k, ...result } = hit;
  return result;
}

export async function putCachedLookup(key: string, result: LookupResult) {
  await (await db()).put('lookupCache', { ...result, key });
}

let persistRequested = false;
/** Ask the browser to keep our storage (reduces iOS Safari eviction risk). */
export function requestPersistentStorage() {
  if (persistRequested) return;
  persistRequested = true;
  navigator.storage?.persist?.().catch(() => {});
}
