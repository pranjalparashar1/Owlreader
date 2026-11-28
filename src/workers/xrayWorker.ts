/// <reference lib="webworker" />
/**
 * X-Ray entity extraction, off the main thread. compromise (a small rule-based NLP library, no ML
 * model) tags people, places and organisations; a capitalisation heuristic catches the coined terms
 * and acronyms a dictionary doesn't know ("Bumpgate", "CUDA"). Loaded only when X-Ray is used.
 */
import nlp from 'compromise';
import { capitalisedTerms, isStopWord, proseText, sentences } from '../lib/terms';
import type { EntityKind } from '../types';

export interface ExtractedEntity {
  key: string;
  label: string;
  kind: EntityKind;
  count: number;
  sentence: string;
}

export type XrayRequest =
  { id: number; type: 'page'; text: string } | { id: number; type: 'pages'; pages: Array<{ page: number; text: string }> };

export type XrayResponse =
  | { id: number; type: 'page'; entities: ExtractedEntity[] }
  | { id: number; type: 'pages'; pages: Array<{ page: number; entities: ExtractedEntity[] }> }
  | { id: number; type: 'error'; message: string };

const clean = (s: string) =>
  s
    .replace(/['’]s\b/gu, '')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

const KIND_RANK: Record<EntityKind, number> = { person: 0, place: 1, org: 2, term: 3 };

export function extract(pageText: string): ExtractedEntity[] {
  const text = proseText(pageText);
  if (!text.trim()) return [];
  const doc = nlp(text);
  const tagged = new Map<string, EntityKind>();
  const tag = (list: string[], kind: EntityKind) => {
    for (const raw of list) {
      const l = clean(raw);
      if (l.length > 1 && /^\p{Lu}/u.test(l) && !isStopWord(l)) tagged.set(l.toLowerCase(), tagged.get(l.toLowerCase()) ?? kind);
    }
  };
  tag(doc.people().out('array') as string[], 'person');
  tag(doc.places().out('array') as string[], 'place');
  tag(doc.organizations().out('array') as string[], 'org');

  const out = new Map<string, Omit<ExtractedEntity, 'sentence'>>();
  for (const t of capitalisedTerms(text)) {
    const key = t.label.toLowerCase();
    if (/^\d/.test(key)) continue;
    // "Santa Clara" from the heuristic picks up compromise's "Santa" → place
    let kind: EntityKind = tagged.get(key) ?? 'term';
    if (kind === 'term') {
      // partial overlaps are weaker evidence: a place or organisation beats a person ("Clara")
      const near = [...tagged].filter(([k]) => key.includes(k) || k.includes(key)).map(([, v]) => v);
      kind = (['place', 'org', 'person'] as const).find((k) => near.includes(k)) ?? 'term';
    }
    out.set(key, { key, label: t.label, kind, count: t.count });
  }
  for (const [key, kind] of tagged) {
    if (out.has(key) || [...out.keys()].some((k) => k.includes(key))) continue;
    const count = text.toLowerCase().split(key).length - 1;
    if (!count) continue;
    const at = text.toLowerCase().indexOf(key);
    out.set(key, { key, label: text.slice(at, at + key.length), kind, count });
  }

  const sents = sentences(text);
  return [...out.values()]
    .map((e) => ({ ...e, sentence: firstSentence(sents, e.label) }))
    .sort((a, b) => b.count - a.count || KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.label.localeCompare(b.label));
}

function firstSentence(sents: string[], label: string) {
  const s = sents.find((x) => x.includes(label)) ?? '';
  return s.length > 280 ? `${s.slice(0, 277).trimEnd()}…` : s;
}

self.onmessage = (e: MessageEvent<XrayRequest>) => {
  const req = e.data;
  try {
    if (req.type === 'page') {
      self.postMessage({ id: req.id, type: 'page', entities: extract(req.text) } satisfies XrayResponse);
    } else {
      const pages = req.pages.map((p) => ({ page: p.page, entities: extract(p.text) }));
      self.postMessage({ id: req.id, type: 'pages', pages } satisfies XrayResponse);
    }
  } catch (err) {
    self.postMessage({ id: req.id, type: 'error', message: String(err) } satisfies XrayResponse);
  }
};
