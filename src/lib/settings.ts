import { useCallback, useEffect, useState } from 'react';
import type { ReaderTheme } from '../types';

export interface Settings {
  theme: ReaderTheme;
  fontPct: number; // EPUB font size, percent
  /** Pages (swipe sideways) or Scroll (continuous vertical), for both EPUB and PDF. */
  flow: 'paginated' | 'scrolled';
}

const KEY = 'owl.settings.v1';
const DEFAULTS: Settings = { theme: 'light', fontPct: 110, flow: 'paginated' };

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved.epubFlow && !saved.flow) saved.flow = saved.epubFlow; // 1.0 → 1.1
      delete saved.epubFlow;
      return { ...DEFAULTS, ...saved };
    }
  } catch {
    /* storage unavailable */
  }
  return DEFAULTS;
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
    document.documentElement.dataset.theme = settings.theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute('content', settings.theme === 'dark' ? '#161514' : settings.theme === 'sepia' ? '#efe5cf' : '#faf7f2');
  }, [settings]);
  const update = useCallback((patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), []);
  return [settings, update] as const;
}

export function localFlag(key: string): [boolean, () => void] {
  let v = false;
  try {
    v = localStorage.getItem(key) === '1';
  } catch {
    /* ignore */
  }
  return [
    v,
    () => {
      try {
        localStorage.setItem(key, '1');
      } catch {
        /* ignore */
      }
    },
  ];
}
