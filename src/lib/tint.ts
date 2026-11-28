import type { ReaderTheme } from '../types';

/**
 * Dark and sepia are baked into each page bitmap with canvas compositing (see `tintCanvas`),
 * so the compositor only ever scrolls plain opaque bitmaps. A CSS `filter` forced iOS to
 * re-filter every page on every frame; pdf.js's `pageColors` needs `ctx.filter`, which iOS
 * Safari lacks. Box colour shown before a page has rendered, matching the tinted page:
 */
export const PAGE_BG: Record<ReaderTheme, string> = { light: '#ffffff', sepia: '#f6eedd', dark: '#1f1f1f' };

/**
 * Bakes the reading theme into a rendered page. Dark ≈ CSS `invert(0.88) hue-rotate(180deg)`:
 * invert, pull the contrast in, then put the original hues back with the `hue` blend mode
 * (photos keep their colours, only lightness flips). Sepia multiplies by the paper colour.
 * Every step is a GPU canvas op, no `ctx.filter` and no pixel readback.
 */
export function tintCanvas(canvas: HTMLCanvasElement, theme: ReaderTheme): HTMLCanvasElement {
  if (theme === 'light') return canvas;
  const { width: w, height: h } = canvas;
  if (theme === 'sepia') {
    const ctx = canvas.getContext('2d')!;
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = PAGE_BG.sepia;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    return canvas;
  }
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(canvas, 0, 0);
  ctx.globalCompositeOperation = 'difference';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h); // invert
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 0.24;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, w, h); // white→#1f1f1f, black→#e0e0e0 (the 0.88 in invert(0.88))
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'hue';
  ctx.drawImage(canvas, 0, 0); // original hue, inverted lightness
  ctx.globalCompositeOperation = 'source-over';
  canvas.width = 0; // free the untinted bitmap
  return out;
}
