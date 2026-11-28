import type { Orientation } from '../types';
import { ScissorsIcon, SearchIcon } from './icons';

interface Props {
  /** The selection to look up, or '' for none (a long passage, or iOS-only lookup): Clip only. */
  text: string;
  orientation: Orientation;
  /** Extra bottom offset (px) while the reader's bottom bar is showing. */
  lift?: number;
  onLookup: (text: string) => void;
  /** "Clip": straight to Export with the selected passage. */
  onClip?: () => void;
}

const MAX = 28;
export function truncateLabel(text: string) {
  if (text.length <= MAX) return text;
  const cut = text.slice(0, MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > MAX * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

/**
 * Floating "Look up" button pinned to a fixed safe zone (bottom-center in portrait,
 * bottom-right in landscape) so it never collides with iOS's native selection callout,
 * which always sits right next to the selected words.
 */
export default function LookupPill({ text, orientation, lift = 0, onLookup, onClip }: Props) {
  const position =
    orientation === 'portrait'
      ? { left: '50%', bottom: 'calc(24px + env(safe-area-inset-bottom))', transform: `translateX(-50%) translateY(${-lift}px)` }
      : {
          right: 'calc(20px + env(safe-area-inset-right))',
          bottom: 'calc(20px + env(safe-area-inset-bottom))',
          transform: `translateY(${-lift}px)`,
        };

  return (
    <div className="fixed z-40 flex items-center gap-2" style={{ ...position, transition: 'transform 380ms var(--ease-ios)' }}>
      {text && (
        <button
          key={text}
          type="button"
          className="no-callout animate-pill-in flex max-w-[86vw] items-center gap-2 rounded-full bg-fg py-3 pr-5 pl-4 text-[15px] font-medium text-bg shadow-[0_8px_28px_-6px_rgb(0_0_0/0.45)] ring-1 ring-white/10"
          // Fire on pointerdown (and stop the default) so the tap can't first collapse the
          // selection, which would hide the pill before a click event arrives.
          onPointerDown={(e) => {
            e.preventDefault();
            onLookup(text);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onLookup(text);
            }
          }}
          aria-label={`Look up ${text}`}
        >
          <SearchIcon size={18} strokeWidth={2.2} className="shrink-0 text-accent" />
          <span className="truncate">Look up “{truncateLabel(text)}”</span>
        </button>
      )}
      {onClip && (
        <button
          type="button"
          className="no-callout animate-pill-in flex h-12 shrink-0 items-center justify-center gap-1.5 rounded-full bg-fg pr-4 pl-3.5 text-[15px] font-medium text-bg shadow-[0_8px_28px_-6px_rgb(0_0_0/0.45)] ring-1 ring-white/10"
          // same pointerdown trick: the selection must still exist when Clip Mode reads it
          onPointerDown={(e) => {
            e.preventDefault();
            onClip();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onClip();
            }
          }}
          aria-label="Clip from selection"
        >
          <ScissorsIcon size={18} className="shrink-0 text-accent" />
          <span>Clip</span>
        </button>
      )}
    </div>
  );
}
