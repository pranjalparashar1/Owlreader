/**
 * Small, dependency-free text heuristics shared by the lookup context chips (main thread) and
 * the X-Ray worker: page text from pdf.js items, capitalised-term candidates, sentences.
 */

/** Words that start sentences or headings far more often than they name anything. */
const STOP = new Set(
  (
    'a an and as at but by for from he her his how i if in into is it its me my no nor not of on or our she so ' +
    'that the their them then there these they this those to was we were what when where which while who why ' +
    'will with you your yet after again all also although among another any are because been before being both ' +
    'can could did do does during each even every few first had has have here however last later least less ' +
    'many may might more most much must never next now often once one only other over own perhaps rather ' +
    'same second several should since some still such than though through thus today too two under until upon ' +
    'very well whether would chapter page part section figure table contents index introduction preface ' +
    'appendix notes acknowledgments acknowledgements prologue epilogue mr mrs ms dr st yes oh ok'
  ).split(' '),
);
const MONTHS_DAYS =
  /^(january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;

export const isStopWord = (w: string) => STOP.has(w.toLowerCase()) || MONTHS_DAYS.test(w);

/** pdf.js text items → one string. Line-end hyphens are joined ("pack- aging" → "packaging"). */
export function pageTextFromItems(items: ReadonlyArray<{ str?: string; hasEOL?: boolean }>): string {
  let out = '';
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    out += it.str;
    if (it.hasEOL) out += '\n';
    else if (it.str && !/\s$/.test(it.str)) out += ' ';
  }
  return out
    .replace(/(\p{Ll})-\n(\p{Ll})/gu, '$1$2')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}

/**
 * Drops page furniture (page numbers, ALL-CAPS running headers) and ends short heading lines
 * with a full stop, so a heading doesn't run into the first sentence after it.
 */
export function proseText(text: string): string {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    const words = l.split(/\s+/).length;
    if (l.length <= 8 && /^[\d\s.–—-]+$|^[ivxlcdm]+\.?$/i.test(l)) continue; // page number
    const letters = l.replace(/[^\p{L}]/gu, '');
    if (letters.length >= 4 && letters === letters.toUpperCase() && words <= 8) continue; // running header
    const heading = words <= 6 && /^\p{Lu}/u.test(l) && !/[.!?:;,"”’)\]-]$/.test(l);
    out.push(heading ? `${l}.` : l);
  }
  return out.join('\n');
}

/** Splits text into sentences (good enough for "first mentioned" quotes). */
export function sentences(text: string): string[] {
  const flat = text.replace(/\s*\n\s*/g, ' ');
  return (flat.match(/[^.!?]+(?:[.!?]+["'”’)\]]*|$)/g) ?? [flat]).map((s) => s.trim()).filter(Boolean);
}

export interface TermHit {
  label: string;
  /** Character offset of the first occurrence in the text. */
  index: number;
  count: number;
}

// a capitalised word (or an acronym, or a CamelCase name), optionally joined by more of them
const WORD = String.raw`(?:\p{Lu}[\p{L}\p{N}'’&-]*[\p{L}\p{N}]|\p{Lu}{2,}\d*)`;
// joiners stay inside a name ("Bank of England"); "and" doesn't ("TSMC and Nvidia" is two names)
const RUN = new RegExp(String.raw`${WORD}(?:[ ](?:of|de|von|van|da|la|the)?[ ]?${WORD})*`, 'gu');

/**
 * Capitalised terms that are probably names: multi-word runs ("Santa Clara"), acronyms ("TSMC"),
 * and single capitalised words that appear mid-sentence (so "The" or "However" at a sentence start
 * don't count). Stop words are trimmed from either end.
 */
export function capitalisedTerms(text: string): TermHit[] {
  const out = new Map<string, TermHit>();
  for (const m of text.matchAll(RUN)) {
    let words = m[0].split(' ');
    let index = m.index ?? 0;
    while (words.length && isStopWord(words[0])) {
      index += words[0].length + 1;
      words = words.slice(1);
    }
    while (words.length && (isStopWord(words[words.length - 1]) || /^(of|de|von|van|da|la)$/.test(words[words.length - 1])))
      words = words.slice(0, -1);
    if (!words.length) continue;
    const label = words.join(' ').replace(/['’]s$/u, '');
    if (label.length < 2) continue;
    if (words.length === 1) {
      const acronym = /^\p{Lu}{2,}\d*$/u.test(label);
      const camel = /\p{Ll}\p{Lu}/u.test(label);
      // "The Defect" at a sentence start: judge by where the run began, before "The" was dropped
      const start = m.index ?? 0;
      const before = text.slice(Math.max(0, start - 3), start);
      const sentenceStart = start === 0 || /[.!?:"“\n]\s*$/.test(before) || /^\s*$/.test(before);
      if (!acronym && !camel && sentenceStart) continue;
    }
    const key = label.toLowerCase();
    const hit = out.get(key);
    if (hit) hit.count++;
    else out.set(key, { label, index, count: 1 });
  }
  return [...out.values()];
}

/**
 * 1–2 capitalised terms from the page to offer as context chips for `query`: closest to where the
 * query appears on the page first, then the most frequent. Skips anything the query already holds.
 */
export function nearbyTerms(pageText: string, query: string, exclude: string[] = [], max = 2): string[] {
  const q = query.toLowerCase();
  const skip = [q, ...exclude.map((e) => e.toLowerCase())];
  const text = proseText(pageText);
  const at = text.toLowerCase().indexOf(q);
  const terms = capitalisedTerms(text).filter((t) => {
    const l = t.label.toLowerCase();
    return !skip.some((s) => s && (s.includes(l) || l.includes(s)));
  });
  terms.sort((a, b) =>
    at >= 0 ? Math.abs(a.index - at) - Math.abs(b.index - at) || b.count - a.count : b.count - a.count || a.index - b.index,
  );
  return terms.slice(0, max).map((t) => t.label);
}

/**
 * Starting context for a book, from its PDF Subject or title: "The Nvidia Way: Jensen Huang and…"
 * → "Nvidia Way". Readers can edit it; it's just a hint appended to searches.
 */
export function seedContextTag(title: string, subject?: string): string {
  const s = subject?.replace(/\s+/g, ' ').trim();
  if (s && s.length <= 40 && s.split(' ').length <= 4) return s;
  const main = title
    .split(/[:–—|]| - /)[0]
    .replace(/\s+/g, ' ')
    .trim();
  const words = main.split(' ').filter((w) => !isStopWord(w.replace(/[^\p{L}\p{N}]/gu, '')));
  if (!words.length) return '';
  return words.slice(0, 3).join(' ');
}

/** "{query} {context}" without repeating the context if the query already has it. */
export function withContext(query: string, context?: string): string {
  const c = context?.trim();
  if (!c || query.toLowerCase().includes(c.toLowerCase())) return query.trim();
  return `${query.trim()} ${c}`;
}
