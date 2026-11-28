import { useEffect, useRef } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import type { ReaderTheme } from '../types';
import type { LookupMode, Settings } from '../lib/settings';
import { MinusIcon, PagesIcon, PlusIcon, ScrollIcon } from './icons';

/** Effective X-Ray state for this book: off everywhere, This Page on demand, or Whole Book indexed. */
export type XrayState = 'off' | 'page' | 'book';

const XRAY_STATES: Array<{ id: XrayState; label: string; help: string }> = [
  { id: 'off', label: 'Off', help: 'No scanning at all, and no X-Ray button.' },
  { id: 'page', label: 'This page', help: 'Tap X-Ray in the top bar to list the names and terms on the page you are reading.' },
  {
    id: 'book',
    label: 'Whole book',
    help: 'Indexes this book in the background, pausing while you scroll, so lookups show where a name first appears.',
  },
];

const LOOKUP_MODES: Array<{ id: LookupMode; label: string; help: string }> = [
  { id: 'wiki', label: 'Wiki', help: 'Select text, then tap Look up for Wikipedia, a photo and a map.' },
  { id: 'native', label: 'Safari', help: "Uses iPhone's built-in Look Up in the menu above your selection." },
  { id: 'both', label: 'Both', help: "iPhone's Look Up menu above the words, and OwlReader's Wikipedia button below." },
];

const THEMES: Array<{ id: ReaderTheme; label: string; swatch: string; ink: string }> = [
  { id: 'light', label: 'Light', swatch: '#ffffff', ink: '#1c1917' },
  { id: 'sepia', label: 'Sepia', swatch: '#f4ecd8', ink: '#433422' },
  { id: 'dark', label: 'Dark', swatch: '#121212', ink: '#e7e5e4' },
];

interface Props {
  open: boolean;
  settings: Settings;
  /** Current PDF zoom as a multiplier of fit-width. */
  zoom: number;
  onSettings: (patch: Partial<Settings>) => void;
  /** 1 = in, -1 = out, 0 = fit width */
  onZoom: (dir: 1 | -1 | 0) => void;
  onClose: () => void;
  /** This book's context hint for lookups. */
  contextTag: string;
  onContextTag: (tag: string) => void;
  xray: XrayState;
  onXray: (state: XrayState) => void;
  /** Whole-book indexing progress, when indexing is on. */
  indexProgress?: { indexed: number; total: number } | null;
}

/** Reading settings popover: theme, layout (Pages / Scroll) and zoom. */
export default function ReaderSettings({
  open,
  settings,
  zoom,
  onSettings,
  onZoom,
  onClose,
  contextTag,
  onContextTag,
  xray,
  onXray,
  indexProgress,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  const panelRef = useRef<HTMLElement>(null);
  useFocusTrap(panelRef, open);

  return (
    // inert while closed: the panel stays mounted for its animation, but must not take focus
    <div className={`fixed inset-0 z-40 ${open ? '' : 'pointer-events-none'}`} aria-hidden={!open} inert={!open}>
      <div className="absolute inset-0" onClick={onClose} />
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Reading settings"
        className="absolute rounded-2xl bg-surface p-4 text-fg shadow-[0_12px_40px_-8px_rgb(0_0_0/0.45)] ring-1 ring-line"
        style={{
          top: 'calc(56px + env(safe-area-inset-top))',
          right: 'max(12px, env(safe-area-inset-right))',
          width: 'min(340px, calc(100vw - 24px))',
          maxHeight: 'calc(100dvh - 68px - env(safe-area-inset-top) - env(safe-area-inset-bottom))',
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          transformOrigin: 'top right',
          transform: open ? 'none' : 'scale(0.94) translateY(-6px)',
          opacity: open ? 1 : 0,
          transition: 'transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 140ms ease-out',
        }}
      >
        <Label>Theme</Label>
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              role="radio"
              aria-checked={settings.theme === t.id}
              onClick={() => onSettings({ theme: t.id })}
              className={`flex flex-col items-center gap-1 rounded-xl py-2.5 text-[13px] font-medium ring-1 transition ${
                settings.theme === t.id ? 'ring-2 ring-accent' : 'ring-line'
              }`}
              style={{ background: t.swatch, color: t.ink }}
            >
              <span className="font-serif text-[18px] leading-none">Aa</span>
              {t.label}
            </button>
          ))}
        </div>

        <Label>Layout</Label>
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-2 p-1" role="radiogroup" aria-label="Layout">
          {(
            [
              { id: 'paginated', label: 'Pages', icon: <PagesIcon size={18} /> },
              { id: 'scrolled', label: 'Scroll', icon: <ScrollIcon size={18} /> },
            ] as const
          ).map((o) => (
            <button
              key={o.id}
              role="radio"
              aria-checked={settings.flow === o.id}
              onClick={() => onSettings({ flow: o.id })}
              className={`flex items-center justify-center gap-2 rounded-lg py-2 text-[14px] font-medium transition ${
                settings.flow === o.id ? 'bg-surface shadow-sm ring-1 ring-line' : 'text-muted'
              }`}
            >
              {o.icon}
              {o.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[12px] text-muted">
          {settings.flow === 'paginated' ? 'Swipe or tap the edges to turn pages.' : 'Scroll continuously, top to bottom.'}
        </p>

        <Label>Look up</Label>
        <div className="grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1" role="radiogroup" aria-label="Look up with">
          {LOOKUP_MODES.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={settings.lookupMode === m.id}
              onClick={() => onSettings({ lookupMode: m.id })}
              className={`rounded-lg py-2 text-[14px] font-medium transition ${
                settings.lookupMode === m.id ? 'bg-surface shadow-sm ring-1 ring-line' : 'text-muted'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[12px] text-muted">{LOOKUP_MODES.find((m) => m.id === settings.lookupMode)?.help}</p>

        <Label>Book context</Label>
        <input
          value={contextTag}
          onChange={(e) => onContextTag(e.target.value)}
          placeholder="e.g. Nvidia"
          enterKeyHint="done"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          aria-label="Book context"
          className="h-10 w-full rounded-xl border border-line bg-bg px-3 text-[16px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
        />
        <p className="mt-1.5 text-[12px] text-muted">
          Added to lookups that need it, and offered as a chip in the lookup drawer, so “Mercury” finds the right one.
        </p>

        <Label>X-Ray</Label>
        <div className="grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1" role="radiogroup" aria-label="X-Ray">
          {XRAY_STATES.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={xray === m.id}
              onClick={() => onXray(m.id)}
              className={`rounded-lg py-2 text-[14px] font-medium transition ${
                xray === m.id ? 'bg-surface shadow-sm ring-1 ring-line' : 'text-muted'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[12px] text-muted">{XRAY_STATES.find((m) => m.id === xray)?.help}</p>
        {xray === 'book' && indexProgress && (
          <div className="mt-2">
            <div
              className="h-1.5 overflow-hidden rounded-full bg-surface-2"
              role="progressbar"
              aria-label="Whole-book index"
              aria-valuemin={0}
              aria-valuemax={indexProgress.total}
              aria-valuenow={indexProgress.indexed}
            >
              <div
                className="h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${indexProgress.total ? (indexProgress.indexed / indexProgress.total) * 100 : 0}%` }}
              />
            </div>
            <p className="mt-1 text-[12px] text-muted tabular-nums" data-testid="index-progress">
              {indexProgress.indexed >= indexProgress.total
                ? `Indexed all ${indexProgress.total} pages`
                : `Indexed ${indexProgress.indexed} / ${indexProgress.total} pages`}
            </p>
          </div>
        )}

        <Label>Zoom</Label>
        <Stepper
          value={`${Math.round(zoom * 100)}%`}
          onValue={() => onZoom(0)}
          valueLabel={`Zoom ${Math.round(zoom * 100)}%. Reset to fit width`}
          onMinus={() => onZoom(-1)}
          onPlus={() => onZoom(1)}
          minusLabel="Zoom out"
          plusLabel="Zoom in"
        />
        <p className="mt-1.5 text-[12px] text-muted">Tap the percentage to fit the page width. You can also pinch to zoom.</p>
      </section>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mt-4 mb-2 text-[12px] font-semibold tracking-wider text-muted uppercase first:mt-0">{children}</div>;
}

function Stepper(props: {
  value: string;
  onValue?: () => void;
  valueLabel?: string;
  onMinus: () => void;
  onPlus: () => void;
  minusLabel: string;
  plusLabel: string;
}) {
  const btn = 'flex h-10 items-center justify-center rounded-lg active:bg-line';
  return (
    <div className="grid grid-cols-[1fr_1.4fr_1fr] items-center gap-1 rounded-xl bg-surface-2 p-1">
      <button className={btn} onClick={props.onMinus} aria-label={props.minusLabel}>
        <MinusIcon size={18} />
      </button>
      {props.onValue ? (
        <button className={`${btn} text-[14px] font-medium tabular-nums`} onClick={props.onValue} aria-label={props.valueLabel}>
          {props.value}
        </button>
      ) : (
        <div className="text-center text-[14px] font-medium tabular-nums">{props.value}</div>
      )}
      <button className={btn} onClick={props.onPlus} aria-label={props.plusLabel}>
        <PlusIcon size={18} />
      </button>
    </div>
  );
}
