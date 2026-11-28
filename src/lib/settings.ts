import { useCallback, useEffect, useState } from 'react';
import type { ReaderTheme } from '../types';

export interface Settings {
  theme: ReaderTheme;
  /** Pages (swipe sideways) or Scroll (continuous vertical). */
  flow: 'paginated' | 'scrolled';
  /**
   * What selecting text offers: Owl's Wikipedia pill ('wiki'), only iOS's own
   * Look Up menu ('native'), or both side by side ('both').
   */
  lookupMode: LookupMode;
  /**
   * X-Ray: 'off' runs no entity scanning at all and hides the X-Ray button. 'on' shows the button
   * (This Page, on demand); whole-book indexing is a separate opt-in per book (BookRecord.xrayWholeBook).
   */
  xray: 'off' | 'on';
}

export type LookupMode = 'wiki' | 'native' | 'both';

const KEY = 'owl.settings.v1';
const DEFAULTS: Settings = { theme: 'light', flow: 'paginated', lookupMode: 'wiki', xray: 'on' };

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      // keep only keys this version knows (drops 1.1's text-size setting and other leftovers)
      const out = { ...DEFAULTS };
      if (saved.theme === 'light' || saved.theme === 'sepia' || saved.theme === 'dark') out.theme = saved.theme;
      if (saved.flow === 'paginated' || saved.flow === 'scrolled') out.flow = saved.flow;
      if (saved.lookupMode === 'wiki' || saved.lookupMode === 'native' || saved.lookupMode === 'both')
        out.lookupMode = saved.lookupMode;
      if (saved.xray === 'off' || saved.xray === 'on') out.xray = saved.xray;
      return out;
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
