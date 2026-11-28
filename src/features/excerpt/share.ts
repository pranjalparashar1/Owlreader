/** iOS share sheet when the browser can share files, otherwise null (callers offer a download). */
export function canShareFile(file: File | File[]) {
  try {
    return !!navigator.canShare?.({ files: Array.isArray(file) ? file : [file] });
  } catch {
    return false;
  }
}

/** Several files (a carousel) go to the share sheet together, in order. */
export async function shareFile(file: File | File[], title: string) {
  try {
    await navigator.share({ files: Array.isArray(file) ? file : [file], title });
    return true;
  } catch (e) {
    // the reader closing the share sheet isn't an error
    if (e instanceof DOMException && e.name === 'AbortError') return true;
    return false;
  }
}

export function fileName(title: string, label: string, ext: string) {
  const slug = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 40) || 'clip';
  return `${slug(title)}-${slug(label.replace(/–/g, '-'))}.${ext}`;
}
