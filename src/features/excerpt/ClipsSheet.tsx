/** This book's saved clips: jump back to one, export it again, or delete it. */
import { useEffect, useRef, useState } from 'react';
import { deleteClip, listClips } from '../../db/libraryDb';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { ClipRange, ClipRecord } from '../../types';
import { CloseIcon, TrashIcon } from '../../components/icons';
import { spanLabel } from './layout';

interface Props {
  bookId: string;
  onGo: (clip: ClipRecord) => void;
  onExport: (range: ClipRange) => void;
  onClose: () => void;
}

export const clipRange = (c: ClipRecord): ClipRange => ({
  start: { page: c.startPage, y: c.startY },
  end: { page: c.endPage, y: c.endY },
});

export default function ClipsSheet({ bookId, onGo, onExport, onClose }: Props) {
  const [clips, setClips] = useState<ClipRecord[] | null>(null);
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
          <button onClick={onClose} className="rounded-full bg-surface-2 p-2" aria-label="Close clips">
            <CloseIcon size={18} />
          </button>
        </div>
        <div className="overflow-y-auto px-4 pb-4">
          {clips?.length === 0 && (
            <p className="py-6 text-center text-[14px] text-muted">
              No clips yet. Tap the scissors in the top bar, drag the handles around a passage, then Save.
            </p>
          )}
          <ul className="space-y-2">
            {clips?.map((c) => (
              <li key={c.id} className="flex items-stretch gap-1 rounded-xl bg-surface-2 ring-1 ring-line">
                <button
                  onClick={() => onGo(c)}
                  className="min-w-0 flex-1 px-3.5 py-2.5 text-left"
                  aria-label={`Go to clip ${c.title}`}
                >
                  <div className="truncate text-[14.5px] font-semibold">{c.title}</div>
                  <div className="text-[12px] text-muted">
                    {spanLabel(clipRange(c))} · {new Date(c.createdAt).toLocaleDateString()}
                  </div>
                  {c.previewText && <div className="mt-0.5 line-clamp-2 font-serif text-[13px] text-muted">{c.previewText}</div>}
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
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
