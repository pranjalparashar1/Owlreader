import type { LookupCandidate, LookupResult, MarkedText } from '../types';
import { getCachedLookup, putCachedLookup } from '../db/libraryDb';
import { withContext } from '../lib/terms';

const REST = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const ACTION = 'https://en.wikipedia.org/w/api.php';
const TIMEOUT_MS = 8000;
/** Cached lookups older than this are refetched when online (kept and shown if that fails). */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Wikimedia asks browser clients to identify themselves with this header (User-Agent can't be set from JS).
const API_USER_AGENT = `OwlReader/${__APP_VERSION__} (https://github.com/pranjalparashar1/Owlreader)`;

export interface LookupResponse {
  result: LookupResult;
  fromCache: boolean;
}

export class OfflineError extends Error {
  constructor() {
    super("You're offline and this hasn't been looked up before.");
  }
}

/** Wikipedia didn't answer in time, is rate-limiting us (429) or is having trouble (5xx). Worth retrying. */
export class ServiceError extends Error {
  constructor(
    readonly reason: 'timeout' | 'busy' | 'server',
    readonly status?: number,
  ) {
    super(
      reason === 'timeout'
        ? 'Wikipedia is taking too long to respond.'
        : reason === 'busy'
          ? 'Wikipedia is busy right now.'
          : "Wikipedia isn't responding properly right now.",
    );
  }
}

/** Trim, collapse whitespace, strip surrounding quotes/punctuation and a trailing possessive. */
export function normalizeQuery(raw: string): string {
  let q = raw.replace(/[\s\u00a0]+/g, ' ').trim();
  // hyphenated line breaks from PDFs: "Blen- heim" -> "Blenheim"
  q = q.replace(/(\p{L})- (\p{Ll})/gu, '$1$2');
  const edge = /^[\s"'“”‘’«»‹›()[\]{}<>.,;:!?¿¡…–—*_~`]+|[\s"'“”‘’«»‹›()[\]{}<>.,;:!?¿¡…–—*_~`]+$/gu;
  for (let i = 0; i < 3; i++) {
    const before = q;
    q = q
      .replace(edge, '')
      .replace(/['’]s$/iu, '')
      .replace(/(\p{L})['’]$/u, '$1');
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

/**
 * GET JSON with an 8 s timeout. 404 and other 4xx come back as a status so callers can fall
 * back to search; 429/5xx and timeouts throw ServiceError so the drawer offers Retry instead of
 * a misleading "not found".
 */
async function fetchJson(url: string): Promise<{ status: number; data?: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: 'application/json', 'Api-User-Agent': API_USER_AGENT },
        signal: ctrl.signal,
      });
    } catch {
      if (ctrl.signal.aborted) throw new ServiceError('timeout');
      throw new OfflineError();
    }
    if (res.status === 429) throw new ServiceError('busy', 429);
    if (res.status >= 500) throw new ServiceError('server', res.status);
    if (!res.ok) return { status: res.status };
    try {
      return { status: res.status, data: await res.json() };
    } catch {
      // body cut off by the timeout, or not JSON
      throw new ServiceError(ctrl.signal.aborted ? 'timeout' : 'server', res.status);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Pick an image no wider than ~1200px: the original can be a 30 MB TIFF-derived JPEG. */
function pickImage(d: SummaryJson) {
  const orig = d.originalimage;
  const thumb = d.thumbnail;
  const img = orig && orig.width <= 1600 ? orig : (thumb ?? orig);
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

interface SearchHit {
  title: string;
  snippet: string;
  sectiontitle?: string;
}

/** Search snippets mark matches with <span class="searchmatch">; keep those marks, drop other HTML. */
export function markSnippet(html: string): MarkedText {
  const out: MarkedText = [];
  const re = /<span class="searchmatch">(.*?)<\/span>/g;
  let last = 0;
  for (const m of html.matchAll(re)) {
    const before = stripHtml(html.slice(last, m.index));
    if (before) out.push([before, false]);
    out.push([stripHtml(m[1]), true]);
    last = (m.index ?? 0) + m[0].length;
  }
  const rest = stripHtml(html.slice(last));
  if (rest) out.push([rest, false]);
  // stripHtml trims each piece: put the spaces between pieces back
  return out.map(([t, b], i) => [i && !/^[,.;:!?)]/.test(t) ? ` ${t}` : t, b]);
}

async function searchHits(query: string): Promise<SearchHit[]> {
  const url =
    `${ACTION}?action=query&list=search&srsearch=${encodeURIComponent(query)}` +
    `&srlimit=6&srprop=${encodeURIComponent('snippet|sectiontitle')}&format=json&origin=*`;
  const { data } = await fetchJson(url);
  return (data as { query?: { search?: SearchHit[] } })?.query?.search ?? [];
}

function toCandidates(hits: SearchHit[], exclude?: string): LookupCandidate[] {
  return (
    hits
      .filter((h) => !/\(disambiguation\)$/i.test(h.title))
      // the disambiguation page itself often comes back as a hit ("Mercury" for "mercury");
      // tapping it would just show this same list again, which looks like the tap did nothing
      .filter((h) => !exclude || h.title.toLowerCase() !== exclude)
      .filter((h, i, all) => all.findIndex((o) => o.title === h.title) === i)
      .slice(0, 4)
      .map((h) => ({ title: h.title, snippet: stripHtml(h.snippet), ...(h.sectiontitle ? { section: h.sectiontitle } : {}) }))
  );
}

/** Link to a section of an article on mobile Wikipedia. */
export function sectionUrl(title: string, section: string) {
  const enc = (s: string) => encodeURIComponent(s.replace(/ /g, '_'));
  return `https://en.m.wikipedia.org/wiki/${enc(title)}#${enc(section)}`;
}

/** Web search for when Wikipedia has nothing useful. */
export function googleUrl(query: string) {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
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

export interface LookupOptions {
  /** Skip normalization; used when the user taps a candidate. */
  exactTitle?: boolean;
  /** Bypass the saved copy and overwrite it. */
  refresh?: boolean;
  /** The book's context hint ("Nvidia"), added to the search when there's no exact article. */
  context?: string;
}

/**
 * Lookup pipeline: normalize → IndexedDB cache → REST summary → (404 or disambiguation)
 * MediaWiki search, boosted with the book's context when it has one, which gives either a
 * matching section inside a broader article or up to 4 candidates.
 *
 * Exact articles are cached under the query alone (they don't depend on the book). Search-based
 * results are cached per context, so the same word in two different books can resolve differently.
 */
export async function lookup(raw: string, opts: LookupOptions = {}): Promise<LookupResponse> {
  const query = opts.exactTitle ? raw.trim() : normalizeQuery(raw);
  if (!query) throw new Error('Nothing to look up.');
  const key = query.toLowerCase();
  const context = opts.exactTitle ? undefined : contextFor(query, opts.context);
  const ctxKey = context ? `${key}|${context.toLowerCase()}` : key;

  let cached: LookupResult | undefined;
  if (!opts.refresh) {
    const plain = await getCachedLookup(key).catch(() => undefined);
    // a plain-key list or section result came from a context-free search: with a context, look again
    cached = !context || plain?.type === 'standard' ? plain : await getCachedLookup(ctxKey).catch(() => undefined);
    if (!cached && plain) cached = plain; // used only if fetching fails (offline)
  }
  const usable = cached && (!context || cached.type === 'standard' || (cached.context ?? '') === context);
  if (cached && usable && Date.now() - (cached.cachedAt ?? 0) <= CACHE_TTL_MS) return fromCache(cached, key);
  try {
    return await fetchAndCache(query, key, context, ctxKey);
  } catch (e) {
    // stale or context-less copy: an old answer beats an error when offline or rate-limited
    if (cached && (e instanceof OfflineError || e instanceof ServiceError)) return fromCache(cached, key);
    throw e;
  }
}

/** The context hint, unless it's empty or already part of the query. */
function contextFor(query: string, context?: string) {
  const c = context?.trim();
  if (!c) return undefined;
  return withContext(query, c) === query ? undefined : c;
}

function fromCache(cached: LookupResult, key: string): LookupResponse {
  // lists cached before 1.1.1 may still include the disambiguation page itself
  if (cached.type === 'disambiguation' && cached.candidates) {
    const self = cached.title.toLowerCase();
    cached.candidates = cached.candidates.filter((c) => c.title.toLowerCase() !== self && c.title.toLowerCase() !== key);
  }
  return { result: cached, fromCache: true };
}

async function fetchAndCache(query: string, key: string, context: string | undefined, ctxKey: string): Promise<LookupResponse> {
  const summary = await fetchSummary(query);
  if (summary && summary.type !== 'disambiguation') {
    const result = toStandard(query, summary);
    await putCachedLookup(key, result).catch(() => {});
    return { result, fromCache: false };
  }

  const isDisambig = summary?.type === 'disambiguation';
  let hits = await searchHits(withContext(query, context));
  // a context that matches nothing (an odd title) mustn't turn a findable word into "not found"
  if (context && hits.length === 0) {
    hits = await searchHits(query);
  }
  const candidates = toCandidates(hits, isDisambig ? (summary?.title?.toLowerCase() ?? key) : undefined);
  const save = async (result: LookupResult) => {
    await putCachedLookup(ctxKey, result).catch(() => {});
    return { result, fromCache: false };
  };

  // A lowercase or slightly-off query ("blenheim palace") 404s on the REST API but its top
  // search hit is an exact match: resolve it directly instead of showing a one-item list.
  const top = hits[0];
  if (!summary && top && top.title.toLowerCase() === key) {
    const exact = await fetchSummary(top.title);
    if (exact && exact.type !== 'disambiguation') {
      const result = toStandard(query, exact);
      await putCachedLookup(key, result).catch(() => {});
      return { result, fromCache: false };
    }
  }

  // No article by that name, but the best match is a section inside a broader one ("Bumpgate"
  // inside the Nvidia article): show that section's heading and snippet, not the article's lead.
  if (!summary && top?.sectiontitle && !/\(disambiguation\)$/i.test(top.title)) {
    return save({
      query,
      title: top.title,
      extract: '',
      type: 'section',
      section: { title: top.sectiontitle, snippet: markSnippet(top.snippet) },
      pageUrl: sectionUrl(top.title, top.sectiontitle),
      candidates: candidates.filter((c) => c.title !== top.title || c.section !== top.sectiontitle).slice(0, 3),
      context,
      cachedAt: Date.now(),
    });
  }

  if (candidates.length === 0) {
    return {
      result: { query, title: query, extract: '', type: 'not_found', context, cachedAt: Date.now() },
      fromCache: false,
    };
  }

  return save({
    query,
    title: summary?.title ?? query,
    description: summary?.description,
    extract: '',
    type: 'disambiguation',
    candidates,
    context,
    cachedAt: Date.now(),
  });
}

export function osmEmbedUrl(lat: number, lon: number, span = 0.03) {
  const bbox = [lon - span, lat - span * 0.6, lon + span, lat + span * 0.6].map((n) => n.toFixed(5)).join(',');
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat.toFixed(5)},${lon.toFixed(5)}`;
}

export function osmPageUrl(lat: number, lon: number) {
  return `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=13/${lat.toFixed(5)}/${lon.toFixed(5)}`;
}
