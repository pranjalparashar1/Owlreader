import type { ReaderTheme } from '../types';

export interface RelocateDetail {
  fraction?: number;
  cfi?: string;
  tocItem?: { label?: string };
  location?: { current: number; total: number };
}

export interface FoliateRenderer extends HTMLElement {
  setStyles?: (css: string | [string, string]) => void;
  next: () => Promise<void>;
  prev: () => Promise<void>;
}

export interface FoliateView extends HTMLElement {
  open(book: File): Promise<void>;
  close(): void;
  init(opts: { lastLocation?: string; showTextStart?: boolean }): Promise<void>;
  goTo(target: string | number): Promise<unknown>;
  goToFraction(frac: number): Promise<void>;
  goLeft(): Promise<void>;
  goRight(): Promise<void>;
  renderer: FoliateRenderer;
  book: { dir?: string };
  lastLocation?: RelocateDetail;
}

export const THEME_COLORS: Record<ReaderTheme, { bg: string; fg: string; link: string; scheme: 'light' | 'dark' }> = {
  light: { bg: '#ffffff', fg: '#1c1917', link: '#1d4ed8', scheme: 'light' },
  sepia: { bg: '#f4ecd8', fg: '#433422', link: '#8a4b0f', scheme: 'light' },
  dark: { bg: '#121212', fg: '#d6d3d1', link: '#93c5fd', scheme: 'dark' },
};

export function epubCss(theme: ReaderTheme, fontPct: number) {
  const c = THEME_COLORS[theme];
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
      color-scheme: ${c.scheme};
      font-size: ${fontPct}% !important;
      background: ${c.bg} !important;
      color: ${c.fg} !important;
      -webkit-text-size-adjust: none;
    }
    body { background: transparent !important; color: inherit !important; }
    body *:not(a):not(img):not(svg):not(svg *) { color: inherit !important; background-color: transparent !important; border-color: currentColor; }
    a:any-link { color: ${c.link} !important; }
    p, li, blockquote, dd { line-height: 1.5; hyphens: auto; -webkit-hyphens: auto; widows: 2; orphans: 2; }
    img, svg { max-width: 100%; height: auto; }
    ${theme === 'dark' ? 'img { filter: brightness(0.9); }' : ''}
    ::selection { background: ${theme === 'dark' ? 'rgba(245, 158, 11, 0.4)' : 'rgba(245, 158, 11, 0.35)'}; }
    pre { white-space: pre-wrap !important; }
  `;
}

export function metaString(v: unknown): string | undefined {
  if (!v) return undefined;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const parts = v.map(metaString).filter(Boolean);
    return parts.length ? parts.join(', ') : undefined;
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('name' in o) return metaString(o.name);
    const first = Object.values(o)[0];
    return metaString(first);
  }
  return String(v);
}
