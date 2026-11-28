/**
 * This book's saved clips: jump back to one, export it again, delete it, or select several and
 * combine them into one mini-PDF (a contents page, then each clip's cropped pages).
 */
import { useEffect, useRef, useState } from 'react';
import { deleteClip, getBookFile, listClips } from '../../db/libraryDb';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { PDFDocumentProxy } from '../../lib/pdfjs';
import type { BookRecord, ClipRange, ClipRecord } from '../../types';
import { CloseIcon, TrashIcon } from '../../components/icons';
import { spanLabel } from './layout';
import { canShareFile, fileName, shareFile } from './share';

interface Props {
  book: BookRecord;
  doc: PDFDocumentProxy | null;
  onGo: (clip: ClipRecord) => void;
  onExport: (range: ClipRange) => void;
  onClose: () => void;
}

export const clipRange = (c: ClipRecord): ClipRange => ({
  start: { page: c.startPage, y: c.startY },
  end: { page: c.endPage, y: c.endY },
});

export default function ClipsSheet({ book, doc, onGo, onExport, onClose }: Props) {
  const bookId = book.id;
  const [clips, setClips] = useState<ClipRecord[] | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [dossier, setDossier] = useState<{ file: File; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => void (dossier && URL.revokeObjectURL(dossier.url)), [dossier]);

  const toggle = (id: string) => {
    setDossier(null);
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };
  const combine = async () => {
    if (!doc || !clips) return;
    setBusy(true);
    setError(null);
    try {
      const stored = await getBookFile(book.id);
      if (!stored) throw new Error('The book file is missing.');
      const { exportDossier } = await import('./pdf');
      const chosen = clips.filter((c) => picked.includes(c.id)).map((c) => ({ range: clipRange(c), title: c.title }));
      const bytes = await exportDossier(stored.data, doc, chosen, book);
      const file = new File([bytes as BlobPart], fileName(book.title, `${chosen.length} clips`, 'pdf'), {
        type: 'application/pdf',
      });
      setDossier({ file, url: URL.createObjectURL(file) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't combine these clips.");
    } finally {
      setBusy(false);
    }
  };
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true);
  useEffect(() => {
    listClips(bookId)
      .then(setClips)
      .catch(() => setClips([]));
  }, [bookId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[55] flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="clips-title"
        className="pb-safe flex max-h-[80dvh] w-full max-w-md flex-col overflow-hidden rounded-t-[20px] bg-surface text-fg shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center px-4 pt-4 pb-2">
          <h2 id="clips-title" className="flex-1 text-[17px] font-semibold">
            Clips
          </h2>
          {(clips?.length ?? 0) > 1 && (
            <button
              onClick={() => {
                setSelecting((v) => !v);
                setPicked([]);
                setDossier(null);
              }}
              className="mr-1 rounded-full px-3 py-1.5 text-[14px] font-medium active:bg-surface-2"
            >
              {selecting ? 'Done' : 'Select'}
            </button>
          )}
          <button onClick={onClose} className="rounded-full bg-surface-2 p-2" aria-label="Close clips">
            <CloseIcon size={18} />
          </button>
        </div>
        <div className="overflow-y-auto px-4 pb-4">
          {clips?.length === 0 && (
            <p className="py-6 text-center text-[14px] text-muted">
              No clips yet. Select text and tap Clip, or tap the scissors in the top bar and tap the paragraphs you want, then
              Save.
            </p>
          )}
          <ul className="space-y-2">
            {clips?.map((c) => (
              <li key={c.id} className="flex items-stretch gap-1 rounded-xl bg-surface-2 ring-1 ring-line">
                {selecting ? (
                  <button
                    role="checkbox"
                    aria-checked={picked.includes(c.id)}
                    onClick={() => toggle(c.id)}
                    className="flex min-w-0 flex-1 items-center gap-3 px-3.5 py-2.5 text-left"
                    aria-label={`Select clip ${c.title}`}
                  >
                    <span
                      aria-hidden
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[13px] font-bold ring-1 ${
                        picked.includes(c.id) ? 'bg-accent text-accent-fg ring-accent' : 'ring-line'
                      }`}
                    >
                      {picked.includes(c.id) ? '✓' : ''}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px] font-semibold">{c.title}</span>
                      <span className="block text-[12px] text-muted">{spanLabel(clipRange(c))}</span>
                    </span>
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => onGo(c)}
                      className="min-w-0 flex-1 px-3.5 py-2.5 text-left"
                      aria-label={`Go to clip ${c.title}`}
                    >
                      <div className="truncate text-[14.5px] font-semibold">{c.title}</div>
                      <div className="text-[12px] text-muted">
                        {spanLabel(clipRange(c))} · {new Date(c.createdAt).toLocaleDateString()}
                      </div>
                      {c.previewText && (
                        <div className="mt-0.5 line-clamp-2 font-serif text-[13px] text-muted">{c.previewText}</div>
                      )}
                    </button>
                    <div className="flex flex-col justify-center gap-1 pr-2">
                      <button
                        onClick={() => onExport(clipRange(c))}
                        className="rounded-full px-2.5 py-1 text-[12.5px] font-medium active:bg-line"
                        aria-label={`Export clip ${c.title}`}
                      >
                        Export
                      </button>
                      <button
                        onClick={async () => {
                          await deleteClip(c.id);
                          setClips((cs) => cs?.filter((x) => x.id !== c.id) ?? null);
                        }}
                        className="flex justify-center rounded-full p-1.5 text-muted active:bg-line"
                        aria-label={`Delete clip ${c.title}`}
                      >
                        <TrashIcon size={16} />
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
        {selecting && (
          <div className="border-t border-line px-4 pt-3 pb-3">
            {error && (
              <p role="alert" className="mb-2 text-[13px] text-red-700 dark:text-red-300">
                {error}
              </p>
            )}
            {dossier ? (
              <div className="flex gap-2">
                {canShareFile(dossier.file) && (
                  <button
                    onClick={() => shareFile(dossier.file, `${book.title}: ${picked.length} clips`)}
                    className="flex-1 rounded-xl bg-fg py-3 text-[15px] font-semibold text-bg"
                  >
                    Share…
                  </button>
                )}
                <a
                  href={dossier.url}
                  download={dossier.file.name}
                  className={`flex flex-1 items-center justify-center rounded-xl py-3 text-[15px] font-semibold ${
                    canShareFile(dossier.file) ? 'bg-surface-2 ring-1 ring-line' : 'bg-fg text-bg'
                  }`}
                >
                  Download PDF
                </a>
              </div>
            ) : (
              <button
                onClick={combine}
                disabled={picked.length < 2 || busy || !doc}
                className="w-full rounded-xl bg-fg py-3 text-[15px] font-semibold text-bg disabled:opacity-50"
              >
                {busy ? 'Combining…' : picked.length < 2 ? 'Pick 2 or more clips' : `Combine ${picked.length} into Mini-PDF`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
