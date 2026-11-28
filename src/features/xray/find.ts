import type { BookEntity, BookIndexRecord } from '../../types';

/** The index entry for a looked-up word, if the book mentions it. */
export function findEntity(record: BookIndexRecord | null | undefined, query: string): BookEntity | undefined {
  if (!record) return undefined;
  const q = query.trim().toLowerCase();
  return record.entities[q] ?? record.entities[q.replace(/['’]s$/, '')];
}
