/**
 * Export studio for a clip: stitched image, cropped or clean PDF, or Markdown. Loaded on demand;
 * pdf-lib is imported only when a PDF is actually made.
 */
import { useEffect, useRef, useState } from 'react';
import { getBookFile } from '../../db/libraryDb';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { PDFDocumentProxy } from '../../lib/pdfjs';
import type { BookRecord, ClipRange, ReaderTheme } from '../../types';
import { CloseIcon } from '../../components/icons';
import { exportImage } from './image';
import { spanLabel } from './layout';
import { canShareFile, fileName, shareFile } from './share';
import { citationText, passageBlocks, toMarkdown, type Citation } from './text';

type Format = 'image' | 'pdf' | 'markdown';
type PdfMode = 'crop' | 'clean';

interface Props {
  book: BookRecord;
  range: ClipRange;
  doc: PDFDocumentProxy;
  theme: ReaderTheme;
  onClose: () => void;
}

interface Result {
  file: File;
  url: string;
  text?: string;
}

export default function ExportSheet({ book, range, doc, theme, onClose }: Props) {
  const [format, setFormat] = useState<Format>('image');
  const [imgTheme, setImgTheme] = useState<ReaderTheme>(theme);
  const [footer, setFooter] = useState(true);
  const [pdfMode, setPdfMode] = useState<PdfMode>('crop');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true);
  const label = spanLabel(range);
  const cite: Citation = { title: book.title, author: book.author, range };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // (re)make the file whenever the format or its options change
  useEffect(() => {
    let alive = true;
    setBusy(true);
    setError(null);
    setCopied(false);
    (async () => {
      let file: File;
      let text: string | undefined;
      if (format === 'image') {
        const blob = await exportImage(doc, range, { theme: imgTheme, footer: footer ? citationText(cite) : null });
        file = new File([blob], fileName(book.title, label, 'png'), { type: 'image/png' });
      } else if (format === 'pdf') {
        const pdf = await import('./pdf');
        let bytes: Uint8Array;
        if (pdfMode === 'crop') {
          const stored = await getBookFile(book.id);
          if (!stored) throw new Error('The book file is missing.');
          bytes = await pdf.exportCroppedPdf(stored.data, doc, range, cite);
        } else {
          bytes = await pdf.exportCleanPdf(await passageBlocks(doc, range), cite);
        }
        file = new File([bytes as BlobPart], fileName(book.title, label, 'pdf'), { type: 'application/pdf' });
      } else {
        text = toMarkdown(await passageBlocks(doc, range), cite);
        file = new File([text], fileName(book.title, label, 'md'), { type: 'text/markdown' });
      }
      if (!alive) return;
      setResult({ file, url: URL.createObjectURL(file), text });
    })()
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Couldn't export this clip."))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, imgTheme, footer, pdfMode, doc, range]);
  useEffect(
    () => () => {
      if (result) URL.revokeObjectURL(result.url);
    },
    [result],
  );

  const share = result && canShareFile(result.file);
  const copy = async () => {
    if (!result?.text) return;
    try {
      await navigator.clipboard.writeText(result.text);
      setCopied(true);
    } catch {
      setError("Couldn't copy. Use Download instead.");
    }
  };

  const seg = (on: boolean) =>
    `rounded-lg py-2 text-[14px] font-medium transition ${on ? 'bg-surface shadow-sm ring-1 ring-line' : 'text-muted'}`;

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        className="pb-safe flex max-h-[92dvh] w-full max-w-md flex-col overflow-hidden rounded-t-[20px] bg-surface text-fg shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 pt-4 pb-2">
          <h2 id="export-title" className="min-w-0 flex-1 truncate text-[17px] font-semibold">
            Export {label}
          </h2>
          <button onClick={onClose} className="rounded-full bg-surface-2 p-2" aria-label="Close export">
            <CloseIcon size={18} />
          </button>
        </div>
        <div className="overflow-y-auto px-4 pb-4">
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1" role="radiogroup" aria-label="Format">
            {(
              [
                ['image', 'Image'],
                ['pdf', 'PDF'],
                ['markdown', 'Markdown'],
              ] as const
            ).map(([id, name]) => (
              <button
                key={id}
                role="radio"
                aria-checked={format === id}
                onClick={() => setFormat(id)}
                className={seg(format === id)}
              >
                {name}
              </button>
            ))}
          </div>

          {format === 'image' && (
            <div className="mt-3 flex items-center gap-2">
              <div
                className="grid flex-1 grid-cols-4 gap-1 rounded-xl bg-surface-2 p-1"
                role="radiogroup"
                aria-label="Image theme"
              >
                {(['light', 'sepia', 'dark', 'black'] as const).map((t) => (
                  <button
                    key={t}
                    role="radio"
                    aria-checked={imgTheme === t}
                    onClick={() => setImgTheme(t)}
                    className={seg(imgTheme === t)}
                  >
                    {t[0].toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
              <label className="flex shrink-0 items-center gap-1.5 text-[13px]">
                <input
                  type="checkbox"
                  checked={footer}
                  onChange={(e) => setFooter(e.target.checked)}
                  className="h-4 w-4 accent-[var(--accent)]"
                />
                Footer
              </label>
            </div>
          )}
          {format === 'pdf' && (
            <div className="mt-3 space-y-2" role="radiogroup" aria-label="PDF type">
              {(
                [
                  ['crop', 'Cropped pages', 'The original pages, cut to your clip. Sharp, searchable, keeps diagrams.'],
                  ['clean', 'Clean text', 'The words re-set as one continuous page, with no page breaks.'],
                ] as const
              ).map(([id, name, help]) => (
                <button
                  key={id}
                  role="radio"
                  aria-checked={pdfMode === id}
                  onClick={() => setPdfMode(id)}
                  className={`block w-full rounded-xl px-3.5 py-2.5 text-left ring-1 ${pdfMode === id ? 'ring-2 ring-accent' : 'ring-line'}`}
                >
                  <div className="text-[14px] font-semibold">{name}</div>
                  <div className="text-[12px] text-muted">{help}</div>
                </button>
              ))}
            </div>
          )}

          <div className="mt-3 min-h-[120px] overflow-hidden rounded-xl bg-surface-2 ring-1 ring-line" aria-busy={busy}>
            {busy && <div className="skeleton h-[160px] rounded-none" aria-label="Preparing" />}
            {!busy && error && (
              <p role="alert" className="p-4 text-[14px] text-red-700 dark:text-red-300">
                {error}
              </p>
            )}
            {!busy && !error && result && format === 'image' && (
              <img src={result.url} alt="Clip preview" className="block max-h-[44dvh] w-full object-contain" />
            )}
            {!busy && !error && result && format === 'markdown' && (
              <pre
                className="max-h-[40dvh] overflow-auto p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap"
                data-testid="markdown-preview"
              >
                {result.text}
              </pre>
            )}
            {!busy && !error && result && format === 'pdf' && (
              <div className="p-4 text-[14px]">
                <div className="font-medium">{result.file.name}</div>
                <div className="text-muted">{Math.max(1, Math.round(result.file.size / 1024))} KB</div>
              </div>
            )}
          </div>

          <div className="mt-3 flex gap-2">
            {format === 'markdown' && (
              <button
                onClick={copy}
                disabled={busy || !result}
                className="flex-1 rounded-xl bg-fg py-3 text-[15px] font-semibold text-bg disabled:opacity-50"
              >
                {copied ? 'Copied' : 'Copy as Markdown'}
              </button>
            )}
            {share && format !== 'markdown' && (
              <button
                onClick={() => result && shareFile(result.file, `${book.title}, ${label}`)}
                className="flex-1 rounded-xl bg-fg py-3 text-[15px] font-semibold text-bg"
              >
                Share…
              </button>
            )}
            <a
              href={result && !busy ? result.url : undefined}
              download={result?.file.name}
              aria-disabled={busy || !result}
              className={`flex flex-1 items-center justify-center rounded-xl py-3 text-[15px] font-semibold ${
                share || format === 'markdown' ? 'bg-surface-2 ring-1 ring-line' : 'bg-fg text-bg'
              } ${busy || !result ? 'pointer-events-none opacity-50' : ''}`}
            >
              Download
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
