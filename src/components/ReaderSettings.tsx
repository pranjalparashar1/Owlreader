import { useEffect } from 'react';
import type { ReaderTheme } from '../types';
import type { Settings } from '../lib/settings';
import { MinusIcon, PagesIcon, PlusIcon, ScrollIcon } from './icons';

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
}

/** Reading settings popover: theme, layout (Pages / Scroll) and zoom. */
export default function ReaderSettings({ open, settings, zoom, onSettings, onZoom, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div className={`fixed inset-0 z-40 ${open ? '' : 'pointer-events-none'}`} aria-hidden={!open}>
      <div className="absolute inset-0" onClick={onClose} />
      <section
        role="dialog"
        aria-label="Reading settings"
        className="absolute rounded-2xl bg-surface p-4 text-fg shadow-[0_12px_40px_-8px_rgb(0_0_0/0.45)] ring-1 ring-line"
        style={{
          top: 'calc(56px + env(safe-area-inset-top))',
          right: 'max(12px, env(safe-area-inset-right))',
          width: 'min(340px, calc(100vw - 24px))',
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
