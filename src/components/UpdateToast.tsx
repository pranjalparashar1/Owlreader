import { useState } from 'react';
import { applyUpdate, dismissUpdate, useUpdateAvailable } from '../lib/pwaUpdate';
import { CloseIcon } from './icons';

/** "New version available — Update", below the top bar so it never covers the scrubber or the pill. */
export default function UpdateToast() {
  const available = useUpdateAvailable();
  const [updating, setUpdating] = useState(false);
  if (!available) return null;
  return (
    <div
      role="status"
      className="animate-pill-in fixed inset-x-3 z-[70] mx-auto flex max-w-sm items-center gap-3 rounded-2xl bg-fg py-2 pr-2 pl-4 text-[14px] text-bg shadow-[0_10px_30px_-6px_rgb(0_0_0/0.45)]"
      style={{ top: 'calc(env(safe-area-inset-top) * 1.25 + 60px)' }}
    >
      <span className="flex-1">New version available</span>
      <button
        onClick={() => {
          setUpdating(true);
          applyUpdate();
        }}
        disabled={updating}
        className="rounded-full bg-accent px-3.5 py-1.5 text-[14px] font-semibold text-white disabled:opacity-70"
      >
        {updating ? 'Updating…' : 'Update'}
      </button>
      <button onClick={dismissUpdate} className="rounded-full p-1.5 opacity-75 hover:opacity-100" aria-label="Dismiss update">
        <CloseIcon size={16} />
      </button>
    </div>
  );
}
