import { useEffect, useRef, useState } from 'react';
import { clearLookupCache, storageCounts } from '../db/libraryDb';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { CloseIcon } from './icons';

export function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

interface Info {
  books: number;
  lookups: number;
  usage?: number;
  quota?: number;
  persisted?: boolean;
}

/** What OwlReader keeps on this device, and a way to drop saved lookups without touching books. */
export default function StorageSheet({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true);

  const load = async () => {
    const counts = await storageCounts().catch(() => ({ books: 0, lookups: 0 }));
    const est = await navigator.storage?.estimate?.().catch(() => undefined);
    const persisted = await navigator.storage?.persisted?.().catch(() => undefined);
    setInfo({ ...counts, usage: est?.usage, quota: est?.quota, persisted });
  };
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const clear = async () => {
    setBusy(true);
    await clearLookupCache().catch(() => {});
    setConfirming(false);
    setBusy(false);
    await load();
  };

  const row = (label: string, value: string) => (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="text-[14px] text-muted">{label}</dt>
      <dd className="text-[15px] font-medium tabular-nums">{value}</dd>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="storage-title"
        className="pb-safe w-full max-w-sm rounded-2xl bg-surface p-5 shadow-2xl outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 id="storage-title" className="text-[17px] font-semibold">
            Storage
          </h2>
          <button
            onClick={onClose}
            className="-mr-1 rounded-full p-1.5 text-muted active:bg-surface-2"
            aria-label="Close storage"
          >
            <CloseIcon size={18} />
          </button>
        </div>
        <dl className="mt-2 divide-y divide-line" aria-busy={!info}>
          {row('Space used', info?.usage !== undefined ? formatBytes(info.usage) : info ? 'Not available' : '…')}
          {info?.quota !== undefined && row('Available to OwlReader', formatBytes(info.quota))}
          {row('Books', info ? String(info.books) : '…')}
          {row('Saved lookups', info ? String(info.lookups) : '…')}
        </dl>
        {info?.persisted === false && (
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            The browser may clear this data if your device runs low on space. Adding OwlReader to your Home Screen makes that less
            likely.
          </p>
        )}

        {confirming ? (
          <div className="mt-4 rounded-xl bg-surface-2 p-3" role="alertdialog" aria-labelledby="clear-q">
            <p id="clear-q" className="text-[14px]">
              Delete all {info?.lookups ?? ''} saved lookups and their photos? Your books and reading positions stay.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => setConfirming(false)}
                className="flex-1 rounded-lg bg-surface py-2.5 text-[14px] font-medium"
              >
                Cancel
              </button>
              <button
                onClick={clear}
                disabled={busy}
                className="flex-1 rounded-lg bg-red-600 py-2.5 text-[14px] font-semibold text-white disabled:opacity-60"
              >
                {busy ? 'Clearing…' : 'Clear'}
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            disabled={!info || info.lookups === 0}
            className="mt-4 w-full rounded-xl bg-surface-2 py-3 text-[15px] font-medium disabled:opacity-50"
          >
            Clear Lookup Cache
          </button>
        )}
      </div>
    </div>
  );
}
