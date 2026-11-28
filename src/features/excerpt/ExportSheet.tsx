/**
 * Export studio for a clip: an image (the book's own pages, or an Editorial typeset card, in any
 * theme and aspect ratio, split into a carousel when it's too tall, with tapped sentences
 * highlighted), a cropped or clean PDF, or Markdown. Loaded on demand; pdf-lib is imported only
 * when a PDF is actually made.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { getBookFile } from '../../db/libraryDb';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { PDFDocumentProxy } from '../../lib/pdfjs';
import type { BookRecord, ClipRange, ReaderTheme } from '../../types';
import { CloseIcon } from '../../components/icons';
import {
  contentWidth,
  editorialContent,
  frames,
  originalContent,
  slideBlobs,
  type Content,
  type Mark,
  type Ratio,
  type Slide,
  type Style,
} from './compose';
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
  /** Back to Clip Mode with this range, to move the handles. */
  onAdjust?: () => void;
  /** Offered when the clip isn't saved yet (it came straight from a text selection). */
  onSave?: (range: ClipRange) => Promise<void>;
}

interface Result {
  format: Format;
  files: File[];
  urls: string[];
  text?: string;
  hits?: Slide['hits'][];
  sizes?: Array<{ w: number; h: number }>;
}

// the reader's own choices, remembered on this device
const PREFS = 'owl.export.v1';
interface Prefs {
  style: Style;
  ratio: Ratio;
  footer: boolean;
  mark: Mark;
}
function loadPrefs(): Prefs {
  const d: Prefs = { style: 'original', ratio: 'auto', footer: true, mark: 'amber' };
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) ?? '{}');
    if (p.style === 'original' || p.style === 'editorial') d.style = p.style;
    if (p.ratio === 'auto' || p.ratio === '4:5' || p.ratio === '9:16') d.ratio = p.ratio;
    if (typeof p.footer === 'boolean') d.footer = p.footer;
    if (p.mark === 'amber' || p.mark === 'white') d.mark = p.mark;
  } catch {
    /* storage unavailable */
  }
  return d;
}

const RATIOS: Array<[Ratio, string]> = [
  ['auto', 'Auto'],
  ['4:5', '4:5 Feed'],
  ['9:16', '9:16 Story'],
];

export default function ExportSheet({ book, range, doc, theme, onClose, onAdjust, onSave }: Props) {
  const [format, setFormat] = useState<Format>('image');
  const [prefs, setPrefs] = useState(loadPrefs);
  const { style, ratio, footer, mark } = prefs;
  const setPref = (patch: Partial<Prefs>) =>
    setPrefs((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(PREFS, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  // a dark reader exports on true black by default: #1f1f1f looks grey once it's in a chat
  const [imgTheme, setImgTheme] = useState<ReaderTheme>(theme === 'dark' ? 'black' : theme);
  const [highlights, setHighlights] = useState<ReadonlySet<number>>(new Set());
  const [pdfMode, setPdfMode] = useState<PdfMode>('crop');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true);
  const label = spanLabel(range);
  const cite: Citation = useMemo(() => ({ title: book.title, author: book.author, range }), [book, range]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // ---- image: the content is built once per style, theme and width (the slow part: rendering
  // pages or setting type), then framed again for every footer, ratio or highlight change.
  const built = useRef<{ key: string; content: Promise<Content> } | null>(null);
  useEffect(
    () => () => {
      built.current?.content.then((c) => (c.canvas.width = 0)).catch(() => {});
    },
    [],
  );
  useEffect(() => {
    if (format !== 'image') return;
    let alive = true;
    setBusy(true);
    setError(null);
    (async () => {
      const width = contentWidth(ratio);
      const key = `${style}|${imgTheme}|${width}`;
      if (built.current?.key !== key) {
        // free the old bitmap once nothing is drawing from it (iOS counts canvas memory tightly)
        built.current?.content.then((c) => (c.canvas.width = 0)).catch(() => {});
        const content =
          style === 'editorial'
            ? passageBlocks(doc, range).then((blocks) => editorialContent(blocks, imgTheme, width))
            : originalContent(doc, range, imgTheme, width);
        built.current = { key, content };
      }
      const content = await built.current.content;
      if (!alive) return;
      const slides = frames(content, { ratio, footer: footer ? citationText(cite) : null, highlights, mark });
      const hits = slides.map((sl) => sl.hits);
      const sizes = slides.map((sl) => ({ w: sl.canvas.width, h: sl.canvas.height }));
      const blobs = await slideBlobs(slides);
      if (!alive) return;
      const files = blobs.map(
        (b, i) =>
          new File([b], fileName(book.title, blobs.length > 1 ? `${label} ${i + 1}` : label, 'png'), {
            type: 'image/png',
          }),
      );
      setResult({ format: 'image', files, urls: files.map((f) => URL.createObjectURL(f)), hits, sizes });
    })()
      .catch((e) => {
        if (!alive) return;
        built.current = null;
        setError(e instanceof Error ? e.message : "Couldn't export this clip.");
      })
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [format, style, imgTheme, ratio, footer, highlights, mark, doc, range, cite, book.title, label]);
  useEffect(() => setHighlights(new Set()), [style, range]);

  // ---- PDF and Markdown
  useEffect(() => {
    if (format === 'image') return;
    let alive = true;
    setBusy(true);
    setError(null);
    setCopied(false);
    (async () => {
      let file: File;
      let text: string | undefined;
      if (format === 'pdf') {
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
      setResult({ format, files: [file], urls: [URL.createObjectURL(file)], text });
    })()
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Couldn't export this clip."))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [format, pdfMode, doc, range, cite, book.id, book.title, label]);
  useEffect(
    () => () => {
      result?.urls.forEach((u) => URL.revokeObjectURL(u));
    },
    [result],
  );

  const files = result && result.format === format ? result.files : [];
  const share = files.length > 0 && canShareFile(files);
  const copy = async () => {
    if (!result?.text) return;
    try {
      await navigator.clipboard.writeText(result.text);
      setCopied(true);
    } catch {
      setError("Couldn't copy. Use Download instead.");
    }
  };
  const downloadAll = () => {
    result?.urls.forEach((u, i) =>
      window.setTimeout(() => {
        const a = document.createElement('a');
        a.href = u;
        a.download = files[i].name;
        a.click();
      }, i * 250),
    );
  };

  /** Tap a sentence in the preview to highlight it (tap again to clear). */
  const onPreviewTap = (slide: number) => (e: React.MouseEvent<HTMLImageElement>) => {
    const hits = result?.hits?.[slide];
    const size = result?.sizes?.[slide];
    if (!hits || !size) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * size.w;
    const y = ((e.clientY - r.top) / r.height) * size.h;
    const slop = size.w * 0.01;
    const hit = hits.find((h) => x >= h.x - slop && x <= h.x + h.w + slop && y >= h.y - slop && y <= h.y + h.h + slop);
    if (!hit) return;
    setHighlights((cur) => {
      const next = new Set(cur);
      if (next.has(hit.id)) next.delete(hit.id);
      else next.add(hit.id);
      return next;
    });
  };

  const seg = (on: boolean) =>
    `rounded-lg py-2 text-[14px] font-medium transition ${on ? 'bg-surface shadow-sm ring-1 ring-line' : 'text-muted'}`;
  const segSm = (on: boolean) =>
    `rounded-lg py-1.5 text-[13px] font-medium transition ${on ? 'bg-surface shadow-sm ring-1 ring-line' : 'text-muted'}`;
  const themeName = (t: ReaderTheme) =>
    t === 'light' ? (style === 'editorial' ? 'Paper' : 'Light') : t[0].toUpperCase() + t.slice(1);
  const slides = format === 'image' && result?.format === 'image' ? result.urls : [];

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        className="pb-safe flex max-h-[94dvh] w-full max-w-md flex-col overflow-hidden rounded-t-[20px] bg-surface text-fg shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 pt-4 pb-2">
          <h2 id="export-title" className="min-w-0 flex-1 truncate text-[17px] font-semibold">
            Export {label}
          </h2>
          {onAdjust && (
            <button onClick={onAdjust} className="rounded-full px-3 py-1.5 text-[14px] font-medium active:bg-surface-2">
              Adjust
            </button>
          )}
          {onSave && (
            <button
              disabled={saved}
              onClick={async () => {
                await onSave(range);
                setSaved(true);
              }}
              className="rounded-full px-3 py-1.5 text-[14px] font-medium active:bg-surface-2 disabled:opacity-60"
            >
              {saved ? 'Saved' : 'Save'}
            </button>
          )}
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
            <div className="mt-2.5 space-y-2">
              <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-2 p-1" role="radiogroup" aria-label="Style">
                {(
                  [
                    ['original', 'Original'],
                    ['editorial', 'Editorial'],
                  ] as const
                ).map(([id, name]) => (
                  <button
                    key={id}
                    role="radio"
                    aria-checked={style === id}
                    onClick={() => setPref({ style: id })}
                    className={segSm(style === id)}
                  >
                    {name}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-4 gap-1 rounded-xl bg-surface-2 p-1" role="radiogroup" aria-label="Image theme">
                {(['light', 'sepia', 'dark', 'black'] as const).map((t) => (
                  <button
                    key={t}
                    role="radio"
                    aria-checked={imgTheme === t}
                    aria-label={t[0].toUpperCase() + t.slice(1)}
                    onClick={() => setImgTheme(t)}
                    className={segSm(imgTheme === t)}
                  >
                    {themeName(t)}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1" role="radiogroup" aria-label="Size">
                {RATIOS.map(([id, name]) => (
                  <button
                    key={id}
                    role="radio"
                    aria-checked={ratio === id}
                    onClick={() => setPref({ ratio: id })}
                    className={segSm(ratio === id)}
                  >
                    {name}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3 px-1 text-[13px]">
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={footer}
                    onChange={(e) => setPref({ footer: e.target.checked })}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                  Footer
                </label>
                <span className="min-w-0 flex-1 truncate text-right text-muted">
                  {highlights.size ? `${highlights.size} highlighted` : 'Tap a sentence to highlight'}
                </span>
                <div className="flex gap-1.5" role="radiogroup" aria-label="Highlight colour">
                  {(
                    [
                      ['amber', '#f5b544'],
                      ['white', '#e7e5e4'],
                    ] as const
                  ).map(([id, color]) => (
                    <button
                      key={id}
                      role="radio"
                      aria-checked={mark === id}
                      aria-label={id === 'amber' ? 'Amber' : 'White'}
                      onClick={() => setPref({ mark: id })}
                      className={`h-6 w-6 rounded-full ring-1 ring-line ${mark === id ? 'outline-2 outline-offset-2 outline-accent' : ''}`}
                      style={{ background: color }}
                    />
                  ))}
                </div>
              </div>
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

          <div className="relative mt-3 min-h-[120px] overflow-hidden rounded-xl bg-surface-2 ring-1 ring-line" aria-busy={busy}>
            {busy && !slides.length && <div className="skeleton h-[160px] rounded-none" aria-label="Preparing" />}
            {error && (
              <p role="alert" className="p-4 text-[14px] text-red-700 dark:text-red-300">
                {error}
              </p>
            )}
            {!error && slides.length > 0 && (
              <div
                className={`flex snap-x snap-mandatory gap-2 overflow-x-auto ${slides.length > 1 ? 'p-2' : ''} ${busy ? 'opacity-70' : ''}`}
                data-testid="slides"
              >
                {slides.map((u, i) => (
                  <div
                    key={u}
                    className={`relative shrink-0 snap-center overflow-y-auto ${slides.length > 1 ? 'w-[82%]' : 'w-full'} max-h-[46dvh]`}
                  >
                    <img
                      src={u}
                      alt={slides.length > 1 ? `Clip preview ${i + 1} of ${slides.length}` : 'Clip preview'}
                      className="block h-auto w-full"
                      onClick={onPreviewTap(i)}
                    />
                    {slides.length > 1 && (
                      <span className="absolute top-1.5 right-1.5 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white tabular-nums">
                        {i + 1}/{slides.length}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {!busy && !error && result?.format === 'markdown' && format === 'markdown' && (
              <pre
                className="max-h-[40dvh] overflow-auto p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap"
                data-testid="markdown-preview"
              >
                {result.text}
              </pre>
            )}
            {!busy && !error && result?.format === 'pdf' && format === 'pdf' && files[0] && (
              <div className="p-4 text-[14px]">
                <div className="font-medium">{files[0].name}</div>
                <div className="text-muted">{Math.max(1, Math.round(files[0].size / 1024))} KB</div>
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
                disabled={busy}
                onClick={() => shareFile(files, `${book.title}, ${label}`)}
                className="flex-1 rounded-xl bg-fg py-3 text-[15px] font-semibold text-bg disabled:opacity-50"
              >
                {files.length > 1 ? `Share ${files.length} images…` : 'Share…'}
              </button>
            )}
            {files.length > 1 ? (
              <button
                onClick={downloadAll}
                disabled={busy}
                className={`flex-1 rounded-xl py-3 text-[15px] font-semibold disabled:opacity-50 ${share ? 'bg-surface-2 ring-1 ring-line' : 'bg-fg text-bg'}`}
              >
                Download all
              </button>
            ) : (
              <a
                href={result && !busy ? result.urls[0] : undefined}
                download={files[0]?.name}
                aria-disabled={busy || !result}
                className={`flex flex-1 items-center justify-center rounded-xl py-3 text-[15px] font-semibold ${
                  share || format === 'markdown' ? 'bg-surface-2 ring-1 ring-line' : 'bg-fg text-bg'
                } ${busy || !result ? 'pointer-events-none opacity-50' : ''}`}
              >
                Download
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
