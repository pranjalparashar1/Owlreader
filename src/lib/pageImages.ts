import type { PDFPageProxy } from './pdfjs';

/** Affine matrix [a, b, c, d, e, f], the same layout as canvas `setTransform` and pdf.js. */
export type Matrix = [number, number, number, number, number, number];

// pdf.js OPS codes (stable across 2.x–5.x; see `OPS` in pdfjs-dist). Inlined so this module
// doesn't pull the pdf.js runtime into the main chunk.
const SAVE = 10;
const RESTORE = 11;
const TRANSFORM = 12;
const FORM_BEGIN = 74;
const FORM_END = 75;
const GROUP_BEGIN = 76;
const GROUP_END = 77;
const ANNOT_BEGIN = 80;
const ANNOT_END = 81;
const IMAGE = 85;
const INLINE_IMAGE = 86;
const INLINE_IMAGE_GROUP = 87;
const IMAGE_REPEAT = 88;

const mul = (m: Matrix, n: ArrayLike<number>): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

interface OpList {
  fnArray: ArrayLike<number>;
  argsArray: unknown[];
}

/**
 * Where a page paints raster images, as matrices that map the unit square to PDF user space
 * (pdf.js draws every image into the unit square of the current transform). Image *masks*
 * are left out on purpose: they're painted in the fill colour, like text, so they should
 * invert with it. Images inside annotation appearances are left out too.
 */
export function imageMatrices(ops: OpList): Matrix[] {
  const out: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  let annot = 0;
  const { fnArray, argsArray } = ops;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[] | null;
    switch (fn) {
      case SAVE:
      case GROUP_BEGIN:
        stack.push(ctm);
        break;
      case RESTORE:
      case GROUP_END:
      case FORM_END:
        ctm = stack.pop() ?? ctm;
        break;
      case TRANSFORM:
        if (args) ctm = mul(ctm, args as number[]);
        break;
      case FORM_BEGIN: {
        stack.push(ctm);
        const m = args?.[0] as number[] | null | undefined;
        if (m && m.length === 6) ctm = mul(ctm, m);
        break;
      }
      case ANNOT_BEGIN:
        stack.push(ctm);
        annot++;
        break;
      case ANNOT_END:
        ctm = stack.pop() ?? ctm;
        annot = Math.max(0, annot - 1);
        break;
      case IMAGE:
      case INLINE_IMAGE:
        if (!annot) out.push(ctm);
        break;
      case IMAGE_REPEAT: {
        if (annot || !args) break;
        const [, sx, sy, positions] = args as [unknown, number, number, ArrayLike<number>];
        for (let k = 0; k + 1 < positions.length; k += 2) out.push(mul(ctm, [sx, 0, 0, sy, positions[k], positions[k + 1]]));
        break;
      }
      case INLINE_IMAGE_GROUP: {
        if (annot || !args) break;
        const map = args[1] as Array<{ transform: number[] }>;
        // pdf.js applies entry.transform then scale(1, -1) and draws into (0, -1, 1, 1): the unit square
        for (const e of map) out.push(mul(ctm, e.transform));
        break;
      }
    }
  }
  return out;
}

const cache = new WeakMap<PDFPageProxy, Matrix[]>();

/**
 * Image placements for a page that has just been rendered. Reads the operator list the render
 * already fetched (no second trip to the worker); falls back to asking pdf.js for it.
 */
export async function pageImageMatrices(page: PDFPageProxy, renderTask?: unknown): Promise<Matrix[]> {
  const hit = cache.get(page);
  if (hit) return hit;
  let ops = (renderTask as { _internalRenderTask?: { operatorList?: OpList } } | undefined)?._internalRenderTask?.operatorList;
  if (!ops?.fnArray) {
    try {
      ops = await page.getOperatorList();
    } catch {
      return [];
    }
  }
  const list = imageMatrices(ops);
  cache.set(page, list);
  return list;
}

/**
 * Image placements in a rendered canvas's pixels. `viewportTransform` is the pdf.js viewport's
 * `transform`; `ratio` is any extra device-pixel scale passed to `render({ transform })`.
 */
export function toCanvasSpace(list: Matrix[], viewportTransform: number[], ratio = 1): Matrix[] {
  const base = mul([ratio, 0, 0, ratio, 0, 0], viewportTransform);
  return list.map((m) => mul(base, m));
}
