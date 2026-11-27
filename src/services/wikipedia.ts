import type { LookupCandidate, LookupResult } from '../types';
import { getCachedLookup, putCachedLookup } from '../db/libraryDb';

const REST = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const ACTION = 'https://en.wikipedia.org/w/api.php';

export interface LookupResponse {
  result: LookupResult;
  fromCache: boolean;
}

export class OfflineError extends Error {
  constructor() {
    super("You're offline and this hasn't been looked up before.");
  }
}

/** Trim, collapse whitespace, strip surrounding quotes/punctuation and a trailing possessive. */
export function normalizeQuery(raw: string): string {
  let q = raw.replace(/[\s ]+/g, ' ').trim();
  // hyphenated line breaks from PDFs: "Blen- heim" -> "Blenheim"
  q = q.replace(/(\p{L})- (\p{Ll})/gu, '$1$2');
  const edge = /^[\s"'“”‘’«»‹›()[\]{}<>.,;:!?¿¡…–—*_~`]+|[\s"'“”‘’«»‹›()[\]{}<>.,;:!?¿¡…–—*_~`]+$/gu;
  for (let i = 0; i < 3; i++) {
    const before = q;
    q = q.replace(edge, '').replace(/['’]s$/iu, '').replace(/(\p{L})['’]$/u, '$1');
    if (q === before) break;
  }
  return q.trim();
}

export const cacheKey = (q: string) => normalizeQuery(q).toLowerCase();

export function stripHtml(html: string): string {
  const text = html.replace(/<[^>]*>/g, '');
  // decode the few entities the search API emits
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Keep the first 2–3 sentences so the drawer stays glanceable. */
export function shortenExtract(extract: string, maxSentences = 3, maxChars = 420): string {
  const sentences = extract.match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) ?? [extract];
  let out = '';
  for (const s of sentences.slice(0, maxSentences)) {
    if (out && (out + s).length > maxChars) break;
    out += s;
  }
  return out.trim() || extract;
}

interface SummaryJson {
  type?: string;
  title?: string;
  description?: string;
  extract?: string;
  thumbnail?: { source: string; width: number; height: number };
  originalimage?: { source: string; width: number; height: number };
  content_urls?: { mobile?: { page?: string }; desktop?: { page?: string } };
  coordinates?: { lat: number; lon: number };
}

async function fetchJson(url: string): Promise<{ status: number; data?: unknown }> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    throw new OfflineError();
  }
  if (!res.ok) return { status: res.status };
  return { status: res.status, data: await res.json() };
}

/** Pick an image no wider than ~1200px: the original can be a 30 MB TIFF-derived JPEG. */
function pickImage(d: SummaryJson) {
  const orig = d.originalimage;
  const thumb = d.thumbnail;
  const img = orig && orig.width <= 1600 ? orig : thumb ?? orig;
  if (!img) return {};
  let src = img.source;
  // Upscale the 320px REST thumbnail to something crisp on retina screens.
  if (img === thumb && orig && orig.width > 1600) src = src.replace(/\/(\d+)px-/, '/960px-');
  return { imageUrl: src, imageIsPortrait: img.height > img.width * 1.1 };
}

async function fetchSummary(title: string): Promise<SummaryJson | null> {
  const { status, data } = await fetchJson(REST + encodeURIComponent(title.replace(/ /g, '_')));
  if (status === 404 || !data) return null;
  return data as SummaryJson;
}

async function searchCandidates(query: string): Promise<LookupCandidate[]> {
  const url =
    `${ACTION}?action=query&list=search&srsearch=${encodeURIComponent(query)}` +
    `&srlimit=6&srprop=snippet&format=json&origin=*`;
  const { data } = await fetchJson(url);
  const hits = (data as { query?: { search?: Array<{ title: string; snippet: string }> } })?.query?.search ?? [];
  return hits
    .filter((h) => !/\(disambiguation\)$/i.test(h.title))
    .slice(0, 4)
    .map((h) => ({ title: h.title, snippet: stripHtml(h.snippet) }));
}

function toStandard(query: string, d: SummaryJson): LookupResult {
  return {
    query,
    title: d.title ?? query,
    description: d.description,
    extract: shortenExtract(d.extract ?? ''),
    ...pickImage(d),
    pageUrl: d.content_urls?.mobile?.page ?? d.content_urls?.desktop?.page,
    coordinates: d.coordinates ? { lat: d.coordinates.lat, lon: d.coordinates.lon } : undefined,
    type: 'standard',
    cachedAt: Date.now(),
  };
}

/**
 * Lookup pipeline: normalize → IndexedDB cache → REST summary →
 * (404 or disambiguation) MediaWiki search fallback with up to 4 candidates.
 * `exactTitle` skips normalization; used when the user taps a candidate.
 */
export async function lookup(raw: string, opts: { exactTitle?: boolean } = {}): Promise<LookupResponse> {
  const query = opts.exactTitle ? raw.trim() : normalizeQuery(raw);
  if (!query) throw new Error('Nothing to look up.');
  const key = query.toLowerCase();

  const cached = await getCachedLookup(key).catch(() => undefined);
  if (cached) return { result: cached, fromCache: true };

  const summary = await fetchSummary(query);
  if (summary && summary.type !== 'disambiguation') {
    const result = toStandard(query, summary);
    await putCachedLookup(key, result).catch(() => {});
    return { result, fromCache: false };
  }

  const candidates = await searchCandidates(query);

  // A lowercase or slightly-off query ("blenheim palace") 404s on the REST API but its top
  // search hit is an exact match: resolve it directly instead of showing a one-item list.
  if (!summary && candidates[0] && candidates[0].title.toLowerCase() === key) {
    const exact = await fetchSummary(candidates[0].title);
    if (exact && exact.type !== 'disambiguation') {
      const result = toStandard(query, exact);
      await putCachedLookup(key, result).catch(() => {});
      return { result, fromCache: false };
    }
  }

  if (candidates.length === 0) {
    return {
      result: { query, title: query, extract: '', type: 'not_found', cachedAt: Date.now() },
      fromCache: false,
    };
  }

  const result: LookupResult = {
    query,
    title: summary?.title ?? query,
    description: summary?.description,
    extract: '',
    type: 'disambiguation',
    candidates,
    cachedAt: Date.now(),
  };
  await putCachedLookup(key, result).catch(() => {});
  return { result, fromCache: false };
}

export function osmEmbedUrl(lat: number, lon: number, span = 0.03) {
  const bbox = [lon - span, lat - span * 0.6, lon + span, lat + span * 0.6].map((n) => n.toFixed(5)).join(',');
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat.toFixed(5)},${lon.toFixed(5)}`;
}

export function osmPageUrl(lat: number, lon: number) {
  return `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=13/${lat.toFixed(5)}/${lon.toFixed(5)}`;
}
