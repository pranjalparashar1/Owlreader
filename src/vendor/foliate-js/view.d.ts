// Minimal typings (added by OwlReader) for the parts of foliate-js that the app uses.
export interface FoliateBook {
  metadata?: {
    title?: string | Record<string, string>;
    author?: unknown;
    language?: string | string[];
  };
  sections: unknown[];
  toc?: unknown[];
  dir?: string;
  getCover?: () => Promise<Blob | null>;
}
export function makeBook(file: File): Promise<FoliateBook>;
export class View extends HTMLElement {}
