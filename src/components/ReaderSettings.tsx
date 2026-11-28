import { useEffect, useRef } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import type { ReaderTheme } from '../types';
import type { LookupMode, Settings } from '../lib/settings';
import { ChevronRight, MinusIcon, PagesIcon, PlusIcon, ScissorsIcon, ScrollIcon } from './icons';

const LOOKUP_MODES: Array<{ id: LookupMode; label: string }> = [
  { id: 'wiki', label: 'Wiki' },
  { id: 'native', label: 'iOS' },
  { id: 'both', label: 'Both' },
];

const THEMES: Array<{ id: ReaderTheme; label: string; swatch: string; ink: string }> = [
  { id: 'light', label: 'Light', swatch: '#ffffff', ink: '#1c1917' },
  { id: 'sepia', label: 'Sepia', swatch: '#f4ecd8', ink: '#433422' },
  { id: 'dark', label: 'Dark', swatch: '#121212', ink: '#e7e5e4' },
  { id: 'black', label: 'Black', swatch: '#000000', ink: '#d4d4d4' },
];

interface Props {
  open: boolean;
  settings: Settings;
  /** Current PDF zoom relative to the default (1 = default, which is also the furthest out). */
  zoom: number;
  onSettings: (patch: Partial<Settings>) => void;
  /** Theme changes go through the shell, which crossfades them. */
  onTheme: (theme: ReaderTheme) => void;
  /** A theme being switched to: its swatch shows as selected right away. */
  pendingTheme?: ReaderTheme | null;
  /** 1 = in, -1 = out, 0 = back to the default zoom */
  onZoom: (dir: 1 | -1 | 0) => void;
  onClose: () => void;
  /** Open this book's saved clips. */
  onClips: () => void;
}

/** Reading settings popover: clips, theme, layout, look up and zoom. */
export default function ReaderSettings({
  open,
  settings,
  zoom,
  onSettings,
  onTheme,
  pendingTheme,
  onZoom,
  onClose,
  onClips,
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
        className="settings-panel no-scrollbar absolute rounded-[22px] bg-surface p-4 text-fg shadow-[0_12px_40px_-8px_rgb(0_0_0/0.45)] ring-1 ring-line"
        data-open={open}
        style={{
          top: 'calc(56px + env(safe-area-inset-top))',
          right: 'max(12px, env(safe-area-inset-right))',
          width: 'min(340px, calc(100vw - 24px))',
          maxHeight: 'calc(100dvh - 68px - env(safe-area-inset-top) - env(safe-area-inset-bottom))',
          overflowY: 'auto',
          overscrollBehavior: 'contain',
        }}
      >
        <button
          onClick={onClips}
          className="mb-1 flex w-full items-center gap-2.5 rounded-xl bg-surface-2 px-3.5 py-2.5 text-left text-[15px] font-medium active:bg-line"
        >
          <ScissorsIcon size={18} className="text-accent" />
          <span className="flex-1">Clips</span>
          <ChevronRight size={16} className="text-muted" />
        </button>

        <Label>Theme</Label>
        <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              role="radio"
              aria-checked={(pendingTheme ?? settings.theme) === t.id}
              aria-label={t.label}
              onClick={() => onTheme(t.id)}
              className={`seg-press flex h-12 items-center justify-center rounded-xl ring-1 ${
                (pendingTheme ?? settings.theme) === t.id ? 'ring-2 ring-accent' : 'ring-line'
              }`}
              style={{ background: t.swatch, color: t.ink }}
            >
              <span className="font-serif text-[18px] leading-none">Aa</span>
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
              className={`flex items-center justify-center gap-2 seg-press rounded-lg py-2 text-[14px] font-medium ${
                settings.flow === o.id ? 'bg-surface shadow-sm ring-1 ring-line' : 'text-muted'
              }`}
            >
              {o.icon}
              {o.label}
            </button>
          ))}
        </div>

        <Label>Look up</Label>
        <div className="grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1" role="radiogroup" aria-label="Look up with">
          {LOOKUP_MODES.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={settings.lookupMode === m.id}
              onClick={() => onSettings({ lookupMode: m.id })}
              className={`seg-press rounded-lg py-2 text-[14px] font-medium ${
                settings.lookupMode === m.id ? 'bg-surface shadow-sm ring-1 ring-line' : 'text-muted'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        <Label>Zoom</Label>
        <Stepper
          value={`${Math.round(zoom * 100)}%`}
          onValue={() => onZoom(0)}
          valueLabel={`Zoom ${Math.round(zoom * 100)}%. Default zoom`}
          onMinus={() => onZoom(-1)}
          minusDisabled={zoom <= 1.001}
          onPlus={() => onZoom(1)}
          minusLabel="Zoom out"
          plusLabel="Zoom in"
        />
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
  minusDisabled?: boolean;
  onPlus: () => void;
  minusLabel: string;
  plusLabel: string;
}) {
  const btn = 'flex h-10 items-center justify-center rounded-lg active:bg-line';
  return (
    <div className="grid grid-cols-[1fr_1.4fr_1fr] items-center gap-1 rounded-xl bg-surface-2 p-1">
      <button
        className={`${btn} disabled:opacity-30`}
        onClick={props.onMinus}
        disabled={props.minusDisabled}
        aria-label={props.minusLabel}
      >
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
