import type { BookRecord } from '../types';
import { addBook, requestPersistentStorage } from '../db/libraryDb';
import { seedContextTag } from '../lib/terms';

const COVER_W = 360;

export const isPdfFile = (file: File) => file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';

const titleFromFilename = (name: string) =>
  name
    .replace(/\.pdf$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Untitled';

async function pdfMeta(data: ArrayBuffer) {
  const { pdfjs } = await import('../lib/pdfjs');
  // pdf.js transfers the buffer it is given to its worker, so give it a copy.
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
  try {
    const meta = await doc.getMetadata().catch(() => null);
    const info = (meta?.info ?? {}) as { Title?: string; Author?: string; Subject?: string };
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: COVER_W / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvas, viewport, background: '#ffffff' }).promise;
    return {
      title: info.Title?.trim() || undefined,
      author: info.Author?.trim() || undefined,
      subject: info.Subject?.trim() || undefined,
      coverDataUrl: canvas.toDataURL('image/jpeg', 0.8),
    };
  } finally {
    await doc.destroy();
  }
}

export async function importBook(file: File): Promise<BookRecord> {
  if (!isPdfFile(file)) throw new Error(`"${file.name}" isn't a PDF. OwlReader opens PDF files only.`);
  requestPersistentStorage();
  const data = await file.arrayBuffer();
  let meta: { title?: string; author?: string; subject?: string; coverDataUrl?: string } = {};
  try {
    meta = await pdfMeta(data);
  } catch (e) {
    throw new Error(`Couldn't open "${file.name}". Is it a valid PDF?`, { cause: e });
  }
  const now = Date.now();
  const title = meta.title || titleFromFilename(file.name);
  const book: BookRecord = {
    id: crypto.randomUUID(),
    title,
    author: meta.author,
    format: 'pdf',
    fileSize: file.size,
    addedAt: now,
    lastOpenedAt: now,
    coverDataUrl: meta.coverDataUrl,
    progress: { percentage: 0 },
    contextTag: seedContextTag(title, meta.subject),
  };
  await addBook(book, { data, name: file.name, type: file.type });
  return book;
}
