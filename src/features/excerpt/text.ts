/**
 * Clean text for a clipped passage: lines from the text layer, page furniture dropped,
 * line-end hyphens rejoined, a sentence split by a page break joined back up, headings
 * (larger or bold type), italics and numbered/bulleted lists kept.
 */
import type { PDFDocumentProxy } from '../../lib/pdfjs';
import type { ClipRange } from '../../types';
import { pageLayout, slices, spanLabel, type Line, type PageLayout } from './layout';

export interface Block {
  kind: 'heading' | 'para' | 'item';
  /** Markdown inline text (with *italic* / **bold**). */
  md: string;
  plain: string;
}

const LIST = /^(\d{1,3}[.)]|[•●▪◦‣*–-])\s+/;
const ENDS_SENTENCE = /[.!?:;"”’)\]]$/;

function lineMd(l: Line, heading: boolean) {
  let out = '';
  for (const s of l.spans) {
    const t = s.text;
    if (!t.trim() || heading) {
      out += t;
      continue;
    }
    const lead = t.match(/^\s*/)![0];
    const trail = t.match(/\s*$/)![0];
    const core = t.trim();
    const wrapped = s.bold && s.italic ? `***${core}***` : s.bold ? `**${core}**` : s.italic ? `*${core}*` : core;
    out += lead + wrapped + trail;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function isHeading(l: Line, layout: PageLayout) {
  if (l.size > layout.bodySize * 1.15) return true;
  const allBold = l.spans.every((s) => s.bold || !s.text.trim());
  return allBold && l.text.split(' ').length <= 12 && !ENDS_SENTENCE.test(l.text);
}

/** Joins the next line onto a paragraph, undoing a line-end hyphen ("de-" + "mand"). */
function join(a: string, b: string) {
  if (/\p{Ll}-$/u.test(a) && /^\p{Ll}/u.test(b)) return a.slice(0, -1) + b;
  if (/\p{Ll}-\*+$/u.test(a) && /^\p{Ll}/u.test(b)) return a.replace(/-(\*+)$/, '$1') + b; // hyphen inside emphasis
  return `${a} ${b}`;
}

export async function passageBlocks(doc: PDFDocumentProxy, range: ClipRange): Promise<Block[]> {
  const blocks: Block[] = [];
  let prev: { line: Line; layout: PageLayout; page: number } | null = null;
  for (const s of slices(range)) {
    const layout = await pageLayout(doc, s.page, true);
    const lines = layout.lines.filter((l) => {
      const mid = (l.top + l.bottom) / 2;
      return mid >= s.top && mid <= s.bottom;
    });
    for (const line of lines) {
      const heading = isHeading(line, layout);
      const md = lineMd(line, heading);
      const plain = line.text;
      const last = blocks[blocks.length - 1];
      const item = LIST.test(plain);
      let fresh = !last || heading || item || last.kind === 'heading';
      if (!fresh && prev) {
        const indent = line.x0 - layout.left > (layout.bodySize * 0.8) / layout.width;
        if (prev.page === s.page) {
          const gap = line.baseline - prev.line.baseline;
          fresh = gap > layout.pitch * 1.3 || indent;
          // a list item's wrapped second line continues the item
          if (last.kind === 'item' && !indent && gap <= layout.pitch * 1.3) fresh = false;
        } else {
          // across a page break: carry on unless the last page ended a sentence and this one indents
          fresh = ENDS_SENTENCE.test(prev.line.text) && (indent || last.kind === 'item');
        }
      }
      if (fresh) blocks.push({ kind: heading ? 'heading' : item ? 'item' : 'para', md, plain });
      else {
        last.md = join(last.md, md);
        last.plain = join(last.plain, plain);
      }
      prev = { line, layout, page: s.page };
    }
  }
  return blocks;
}

export interface Citation {
  title: string;
  author?: string;
  range: ClipRange;
}

export const citationText = (c: Citation) => [c.title, c.author, spanLabel(c.range)].filter(Boolean).join(' · ');

/** Blockquote with a citation line, ready to paste into notes. */
export function toMarkdown(blocks: Block[], c: Citation): string {
  const body: string[] = [];
  let n = 0;
  for (const b of blocks) {
    if (b.kind === 'item') {
      // keep the book's own numbering; bullets become "-"
      const m = LIST.exec(b.md);
      const marker = m && /\d/.test(m[1]) ? `${m[1].replace(')', '.')}` : '-';
      body.push(`${marker} ${b.md.replace(LIST, '')}`);
      n++;
      continue;
    }
    if (n) body.push('');
    n = 0;
    body.push(b.kind === 'heading' ? `### ${b.md}` : b.md, '');
  }
  while (body.length && !body[body.length - 1]) body.pop();
  const cite = `— *${c.title}*${c.author ? `, ${c.author}` : ''}, ${spanLabel(c.range)}`;
  return [...body, '', cite].map((l) => (l ? `> ${l}` : '>')).join('\n') + '\n';
}

/** First words of the passage, for a saved clip's title and preview. */
export function preview(blocks: Block[]) {
  const heading = blocks.find((b) => b.kind === 'heading')?.plain;
  const text = blocks
    .filter((b) => b.kind !== 'heading')
    .map((b) => b.plain)
    .join(' ');
  const words = (heading ?? text).split(' ');
  const title = heading ?? words.slice(0, 7).join(' ') + (words.length > 7 ? '…' : '');
  return { title: title || 'Clip', previewText: text.length > 180 ? `${text.slice(0, 177).trimEnd()}…` : text };
}
