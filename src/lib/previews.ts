/**
 * Page previews: one small JPEG per page, held as a blob URL so a page box can paint it as
 * its CSS background the instant the box appears. The browser decodes it off the main
 * thread, and it costs no pdf.js work, so it's safe to show mid-fling. Least recently used
 * entries are revoked once the cache is full.
 */
export class PreviewCache {
  private urls = new Map<number, string>();
  constructor(private max: number) {}

  get(n: number): string | undefined {
    return this.urls.get(n);
  }

  has(n: number) {
    return this.urls.has(n);
  }

  set(n: number, url: string) {
    const old = this.urls.get(n);
    if (old && old !== url) URL.revokeObjectURL(old);
    this.urls.delete(n);
    this.urls.set(n, url);
    while (this.urls.size > this.max) {
      const [k, u] = this.urls.entries().next().value!;
      this.urls.delete(k);
      URL.revokeObjectURL(u);
    }
  }

  /** Marks `n` as recently used, so prefetching around the reader keeps it. */
  touch(n: number) {
    const u = this.urls.get(n);
    if (!u) return;
    this.urls.delete(n);
    this.urls.set(n, u);
  }

  clear() {
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
  }
}

/** Downscales a rendered (already tinted) page to `width` px and encodes it as a JPEG blob URL. */
export function encodePreview(source: HTMLCanvasElement, width: number): Promise<string | null> {
  const w = Math.max(1, Math.min(width, source.width));
  const h = Math.max(1, Math.round((source.height * w) / source.width));
  let canvas = source;
  if (w !== source.width) {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);
  }
  return new Promise((resolve) => {
    try {
      canvas.toBlob(
        (blob) => {
          if (canvas !== source) canvas.width = 0;
          resolve(blob ? URL.createObjectURL(blob) : null);
        },
        'image/jpeg',
        0.72,
      );
    } catch {
      resolve(null);
    }
  });
}
