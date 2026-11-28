import { putClip } from '../../db/libraryDb';
import type { PDFDocumentProxy } from '../../lib/pdfjs';
import type { ClipRange, ClipRecord } from '../../types';
import { passageBlocks, preview } from './text';

/** Saves a clip's coordinates plus a short title and preview (a few hundred bytes). */
export async function saveClip(doc: PDFDocumentProxy, bookId: string, range: ClipRange): Promise<ClipRecord> {
  const { title, previewText } = preview(await passageBlocks(doc, range).catch(() => []));
  const clip: ClipRecord = {
    id: crypto.randomUUID(),
    bookId,
    startPage: range.start.page,
    startY: range.start.y,
    endPage: range.end.page,
    endY: range.end.y,
    title,
    previewText,
    createdAt: Date.now(),
  };
  await putClip(clip);
  return clip;
}
