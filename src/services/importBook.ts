import type { BookFormat, BookRecord } from '../types';
import { addBook, requestPersistentStorage } from '../db/libraryDb';
import { metaString } from '../lib/foliate';

const COVER_W = 360;

export function detectFormat(file: File): BookFormat | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.epub') || file.type === 'application/epub+zip') return 'epub';
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return 'pdf';
  return null;
}

const titleFromFilename = (name: string) =>
  name.replace(/\.(epub|pdf)$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';

async function blobToCover(blob: Blob): Promise<string | undefined> {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, COVER_W / bmp.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return undefined;
  }
}

async function epubMeta(file: File, data: ArrayBuffer) {
  const { makeBook } = await import('../vendor/foliate-js/view.js');
  const book = await makeBook(new File([data], file.name || 'book.epub', { type: 'application/epub+zip' }));
  const title = metaString(book.metadata?.title);
  const author = metaString(book.metadata?.author);
  const coverBlob = await book.getCover?.().catch(() => null);
  const coverDataUrl = coverBlob ? await blobToCover(coverBlob) : undefined;
  return { title, author, coverDataUrl };
}

async function pdfMeta(data: ArrayBuffer) {
  const { pdfjs } = await import('../lib/pdfjs');
  // pdf.js transfers the buffer it is given to its worker, so give it a copy.
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
  try {
    const meta = await doc.getMetadata().catch(() => null);
    const info = (meta?.info ?? {}) as { Title?: string; Author?: string };
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
      coverDataUrl: canvas.toDataURL('image/jpeg', 0.8),
    };
  } finally {
    await doc.destroy();
  }
}

export async function importBook(file: File): Promise<BookRecord> {
  const format = detectFormat(file);
  if (!format) throw new Error(`"${file.name}" isn't an EPUB or PDF.`);
  requestPersistentStorage();
  const data = await file.arrayBuffer();
  let meta: { title?: string; author?: string; coverDataUrl?: string } = {};
  try {
    meta = format === 'epub' ? await epubMeta(file, data) : await pdfMeta(data);
  } catch (e) {
    if (format === 'epub') throw new Error(`Couldn't open "${file.name}". Is it a valid EPUB?`, { cause: e });
    throw new Error(`Couldn't open "${file.name}". Is it a valid PDF?`, { cause: e });
  }
  const now = Date.now();
  const book: BookRecord = {
    id: crypto.randomUUID(),
    title: meta.title || titleFromFilename(file.name),
    author: meta.author,
    format,
    fileSize: file.size,
    addedAt: now,
    lastOpenedAt: now,
    coverDataUrl: meta.coverDataUrl,
    progress: { percentage: 0 },
  };
  await addBook(book, { data, name: file.name, type: file.type });
  return book;
}
