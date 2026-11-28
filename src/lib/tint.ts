import type { ReaderTheme } from '../types';
import type { Matrix } from './pageImages';

/**
 * Dark, black and sepia are baked into each page bitmap with canvas compositing (see
 * `tintCanvas`), so the compositor only ever scrolls plain opaque bitmaps. A CSS `filter`
 * forced iOS to re-filter every page on every frame; pdf.js's `pageColors` needs `ctx.filter`,
 * which iOS Safari lacks. Box colour shown before a page has rendered, matching the tinted page:
 */
export const PAGE_BG: Record<ReaderTheme, string> = {
  light: '#ffffff',
  sepia: '#f6eedd',
  dark: '#1f1f1f',
  black: '#000000',
};

/** True for the themes that flip the page's lightness. */
export const isInverted = (theme: ReaderTheme) => theme === 'dark' || theme === 'black';

/**
 * Bakes the reading theme into a rendered page.
 *
 * Dark ≈ CSS `invert(0.88) hue-rotate(180deg)`: invert, pull the contrast in, then put the
 * original hues back with the `hue` blend mode. That's right for text, rules and line art,
 * but a photo with only its lightness flipped still reads as a negative, so `images` (where
 * the page painted raster images, in canvas pixels; see `pageImages.ts`) are copied back from
 * the untinted render, slightly dimmed, unless they look like a scan or a white-background
 * figure, which invert with the page. Black is the same with a pure #000 page for OLED.
 * Sepia multiplies by the paper colour. Every step is a GPU canvas op, no `ctx.filter`; the
 * only readback is a 24×24 sample per image to tell photos from figures.
 */
export function tintCanvas(canvas: HTMLCanvasElement, theme: ReaderTheme, images: Matrix[] = []): HTMLCanvasElement {
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
  // decide which images to keep before the page is touched (the sample reads the original)
  const photos = images.filter((m) => isPhoto(canvas, m));

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(canvas, 0, 0);
  ctx.globalCompositeOperation = 'difference';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h); // invert
  ctx.globalCompositeOperation = 'source-over';
  if (theme === 'dark') {
    ctx.globalAlpha = 0.24;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, w, h); // white→#1f1f1f, black→#e0e0e0 (the 0.88 in invert(0.88))
  } else {
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h); // white→#000000, black→#e0e0e0: true black for OLED, softer ink
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'hue';
  ctx.drawImage(canvas, 0, 0); // original hue, inverted lightness
  ctx.globalCompositeOperation = 'source-over';

  // photos: the original pixels, dimmed a little so they don't glare against the dark page
  for (const m of photos) {
    ctx.save();
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.beginPath();
    ctx.rect(0, 0, 1, 1);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clip();
    ctx.drawImage(canvas, 0, 0);
    ctx.fillStyle = theme === 'dark' ? 'rgb(0 0 0 / 0.1)' : 'rgb(0 0 0 / 0.16)';
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
  canvas.width = 0; // free the untinted bitmap
  return out;
}

const SAMPLE = 24;
let sampler: CanvasRenderingContext2D | null = null;

/** Axis-aligned pixel box of a unit-square placement, clamped to the canvas. */
function boxOf(m: Matrix, w: number, h: number) {
  const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
  const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(w, Math.ceil(Math.max(...xs)));
  const y1 = Math.min(h, Math.ceil(Math.max(...ys)));
  return { x0, y0, x1, y1 };
}

/**
 * Photo or figure? A scan of a page, a chart or a diagram is mostly flat light background;
 * a photo almost never is. Images under ~6 px are dropped (nothing to see, not worth a sample).
 */
export function isPhoto(src: HTMLCanvasElement, m: Matrix): boolean {
  const { x0, y0, x1, y1 } = boxOf(m, src.width, src.height);
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw < 6 || bh < 6) return false;
  if (!sampler) {
    const c = document.createElement('canvas');
    c.width = SAMPLE;
    c.height = SAMPLE;
    sampler = c.getContext('2d', { willReadFrequently: true });
    if (!sampler) return true;
  }
  sampler.clearRect(0, 0, SAMPLE, SAMPLE);
  sampler.drawImage(src, x0, y0, bw, bh, 0, 0, SAMPLE, SAMPLE);
  const px = sampler.getImageData(0, 0, SAMPLE, SAMPLE).data;
  return classify(px) === 'photo';
}

/** Exposed for tests. `px` is RGBA bytes. */
export function classify(px: Uint8ClampedArray | number[]): 'photo' | 'figure' {
  let paper = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] / 255;
    const g = px[i + 1] / 255;
    const b = px[i + 2] / 255;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (lum > 0.7 && chroma < 0.18) paper++; // white or yellowed paper
    n++;
  }
  return n && paper / n >= 0.5 ? 'figure' : 'photo';
}
