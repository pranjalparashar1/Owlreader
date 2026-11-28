import { useEffect, useRef, useState } from 'react';
import { isSupportedBook, type BookRecord } from '../types';
import { deleteBook, listBooks } from '../db/libraryDb';
import { importBook } from '../services/importBook';
import StorageSheet from './StorageSheet';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { MoreIcon, OwlMark, PlusIcon, SearchIcon, StorageIcon, TrashIcon } from './icons';

interface Props {
  onOpen: (book: BookRecord) => void;
}

const ACCEPT = '.pdf,application/pdf';
const PALETTE = ['#7c2d12', '#1e3a5f', '#14532d', '#4c1d95', '#713f12', '#134e4a', '#831843', '#3f3f46'];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function formatSize(bytes: number) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function Cover({ book }: { book: BookRecord }) {
  if (book.coverDataUrl) {
    return <img src={book.coverDataUrl} alt="" className="h-full w-full object-cover" draggable={false} />;
  }
  const color = PALETTE[hash(book.title) % PALETTE.length];
  return (
    <div className="flex h-full w-full flex-col justify-between p-3 text-left" style={{ background: color, color: '#f5efe4' }}>
      <div className="h-px w-8 bg-current opacity-50" />
      <div>
        <div className="font-serif text-[15px] leading-snug font-semibold line-clamp-5">{book.title}</div>
        {book.author && <div className="mt-2 text-[11px] tracking-wide uppercase opacity-75 line-clamp-2">{book.author}</div>}
      </div>
    </div>
  );
}

function BookCard({ book, onOpen, onMenu }: { book: BookRecord; onOpen: () => void; onMenu: () => void }) {
  const pressTimer = useRef<number | undefined>(undefined);
  const longPressed = useRef(false);
  const start = () => {
    longPressed.current = false;
    pressTimer.current = window.setTimeout(() => {
      longPressed.current = true;
      navigator.vibrate?.(10);
      onMenu();
    }, 550);
  };
  const cancel = () => window.clearTimeout(pressTimer.current);
  const supported = isSupportedBook(book);
  const pct = supported ? Math.round(book.progress?.percentage || 0) : 0;

  return (
    <div className="group relative">
      <button
        className="no-callout block w-full text-left"
        onPointerDown={start}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onContextMenu={(e) => {
          e.preventDefault();
          cancel();
          if (!longPressed.current) onMenu();
          longPressed.current = true;
        }}
        onClick={() => {
          if (longPressed.current) return;
          // books saved by older versions in a format this one can't read: offer deletion instead
          if (supported) onOpen();
          else onMenu();
        }}
        aria-label={supported ? `Open ${book.title}` : `${book.title}, unsupported format. Delete`}
      >
        <div
          className={`relative aspect-[2/3] overflow-hidden ${supported ? '' : 'opacity-50 grayscale'} rounded-md bg-surface-2 shadow-[0_1px_2px_rgb(0_0_0/0.12),0_6px_16px_-6px_rgb(0_0_0/0.25)] ring-1 ring-line transition-transform group-active:scale-[0.98]`}
        >
          <Cover book={book} />
          {pct > 0 && (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-black/25">
              <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
        <div className="mt-2 pr-7">
          <div className="text-[14px] leading-tight font-medium line-clamp-2">{book.title}</div>
          <div className="mt-0.5 text-[12px] text-muted truncate">
            {!supported ? 'Unsupported · tap to delete' : pct > 0 ? `${pct}% read` : 'Not started'}
            {supported && book.author ? ` · ${book.author}` : ''}
          </div>
        </div>
      </button>
      <button
        onClick={onMenu}
        className="absolute right-0 bottom-0 -mr-1.5 rounded-full p-1.5 text-muted hover:bg-surface-2"
        aria-label={`Options for ${book.title}`}
      >
        <MoreIcon />
      </button>
    </div>
  );
}

function ConfirmDelete({ book, onCancel, onConfirm }: { book: BookRecord; onCancel: () => void; onConfirm: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={onCancel}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="del-title"
        className="pb-safe w-full max-w-sm rounded-2xl bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="del-title" className="text-[17px] font-semibold">
          Delete this book?
        </h2>
        <p className="mt-1.5 text-[14px] text-muted">
          {isSupportedBook(book)
            ? `“${book.title}” and your reading position will be removed from this device.`
            : `Owl now opens PDFs only, so “${book.title}” (saved by an earlier version) can't be opened.`}{' '}
          {formatSize(book.fileSize || 0)} will be freed.
        </p>
        <div className="mt-5 flex gap-2">
          <button onClick={onCancel} className="flex-1 rounded-xl bg-surface-2 py-3 text-[15px] font-medium">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-red-600 py-3 text-[15px] font-semibold text-white"
          >
            <TrashIcon size={18} /> Delete
          </button>
        </div>
      </div>
    </div>
  );
}

export default function LibraryView({ onOpen }: Props) {
  const [books, setBooks] = useState<BookRecord[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BookRecord | null>(null);
  const [storageOpen, setStorageOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = () =>
    listBooks()
      .then(setBooks)
      .catch(() => setBooks([]));
  useEffect(() => {
    refresh();
  }, []);

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    const errors: string[] = [];
    for (const file of Array.from(files)) {
      setBusy(`Importing “${file.name}”…`);
      try {
        await importBook(file);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
      await refresh();
    }
    setBusy(null);
    if (errors.length) setError(errors.join(' '));
    if (inputRef.current) inputRef.current.value = '';
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    await deleteBook(pendingDelete.id);
    setPendingDelete(null);
    refresh();
  }

  const importButton = (
    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-fg px-4 py-2 text-[14px] font-semibold text-bg active:opacity-80">
      <PlusIcon size={16} strokeWidth={2.4} /> Import PDF
      <input ref={inputRef} type="file" accept={ACCEPT} multiple className="sr-only" onChange={(e) => onFiles(e.target.files)} />
    </label>
  );

  return (
    <div className="h-dvh-safe overflow-y-auto bg-bg">
      {/* Fixed, opaque, no backdrop-filter, and its buttons sit below the band iOS 26 blurs
          under the status bar (see .pt-safe-bar). */}
      <header className="pt-safe-bar fixed inset-x-0 top-0 z-20 border-b border-line bg-chrome">
        <div className="px-safe mx-auto flex h-14 max-w-5xl items-center justify-between">
          <div className="flex items-center gap-2.5">
            <OwlMark size={28} />
            <h1 className="font-serif text-[21px] font-semibold tracking-tight">Owl</h1>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setStorageOpen(true)}
              className="rounded-full p-2 text-muted active:bg-surface-2"
              aria-label="Storage"
              title="Storage"
            >
              <StorageIcon size={20} />
            </button>
            {importButton}
          </div>
        </div>
      </header>

      <main
        className="px-safe pb-safe mx-auto max-w-5xl pb-10"
        style={{ paddingTop: 'calc(56px + 20px + env(safe-area-inset-top) * 1.25)' }}
      >
        {busy && (
          <div role="status" className="mb-4 flex items-center gap-2 rounded-xl bg-surface-2 px-4 py-3 text-[14px]">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            {busy}
          </div>
        )}
        {error && (
          <div role="alert" className="mb-4 rounded-xl bg-red-500/10 px-4 py-3 text-[14px] text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {books && books.length === 0 && !busy && (
          <div className="mx-auto mt-12 max-w-sm text-center">
            <div className="mx-auto mb-5 w-fit opacity-90">
              <OwlMark size={72} />
            </div>
            <h2 className="font-serif text-[22px] font-semibold">Your shelf is empty</h2>
            <p className="mt-2 text-[15px] leading-relaxed text-muted">
              Import a PDF from Files. Everything stays on this device.
            </p>
            <div className="mt-6">{importButton}</div>
            <div className="mt-10 flex items-start gap-3 rounded-2xl bg-surface p-4 text-left ring-1 ring-line">
              <div className="mt-0.5 rounded-full bg-accent/15 p-2 text-accent">
                <SearchIcon size={18} />
              </div>
              <p className="text-[13.5px] leading-relaxed text-muted">
                <span className="font-semibold text-fg">Select any name or place</span> while reading, then tap the Look up button
                for a photo, a short summary and a map, without leaving your book.
              </p>
            </div>
          </div>
        )}

        {books && books.length > 0 && (
          <>
            <h2 className="mb-3 text-[13px] font-semibold tracking-wider text-muted uppercase">Library</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-4 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
              {books.map((b) => (
                <BookCard key={b.id} book={b} onOpen={() => onOpen(b)} onMenu={() => setPendingDelete(b)} />
              ))}
            </div>
          </>
        )}
      </main>

      {storageOpen && <StorageSheet onClose={() => setStorageOpen(false)} />}
      {pendingDelete && <ConfirmDelete book={pendingDelete} onCancel={() => setPendingDelete(null)} onConfirm={confirmDelete} />}
    </div>
  );
}
