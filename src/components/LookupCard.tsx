import { useState } from 'react';
import type { LookupResult, MarkedText } from '../types';
import { googleUrl, osmEmbedUrl, osmPageUrl } from '../services/wikipedia';
import { withContext } from '../lib/terms';
import { ChevronRight, CloudOffIcon, ExternalIcon, MapIcon, RefreshIcon, SearchIcon } from './icons';

interface Props {
  result: LookupResult;
  fromCache: boolean;
  onPickCandidate: (title: string) => void;
  /** Shorter hero image, for the half-height portrait sheet. */
  compact?: boolean;
  /** Called when the map opens, so a half-height sheet can grow to show it. */
  onMapOpen?: () => void;
  /** Refetch from Wikipedia, replacing the saved copy. Offered on cached results. */
  onRefresh?: () => void;
  /** The book's context hint, added to the Google escape hatch. */
  contextTag?: string;
}

/**
 * Pure renderer for one lookup result. Deliberately knows nothing about text selection,
 * so a future "On This Page" drawer can render auto-extracted entities with it as-is.
 */
export default function LookupCard({ result, fromCache, onPickCandidate, compact, onMapOpen, onRefresh, contextTag }: Props) {
  const web = <WebSearch query={withContext(result.query, contextTag)} />;
  if (result.type === 'disambiguation')
    return (
      <>
        <Candidates result={result} onPick={onPickCandidate} onRefresh={fromCache ? onRefresh : undefined} />
        {web}
      </>
    );
  if (result.type === 'section')
    return (
      <>
        <Section result={result} fromCache={fromCache} onRefresh={onRefresh} onPick={onPickCandidate} />
        {web}
      </>
    );
  if (result.type === 'not_found') {
    return (
      <>
        <div className="px-5 pt-8 pb-2 text-center">
          <p className="font-serif text-[18px] font-semibold">No Wikipedia article found</p>
          <p className="mt-2 text-[14px] text-muted">
            Nothing matched “{result.query}”. Try adding context in the search box above, like a first name or a place.
          </p>
        </div>
        {web}
      </>
    );
  }
  return <Article result={result} fromCache={fromCache} compact={compact} onMapOpen={onMapOpen} onRefresh={onRefresh} />;
}

function Candidates({
  result,
  onPick,
  onRefresh,
}: {
  result: LookupResult;
  onPick: (title: string) => void;
  onRefresh?: () => void;
}) {
  return (
    <div className="px-4 pt-3 pb-5">
      <ul className="mt-3 space-y-2">
        {result.candidates?.map((c) => (
          <li key={c.title}>
            <button
              onClick={() => onPick(c.title)}
              className="flex w-full items-center gap-3 rounded-xl bg-surface-2 px-4 py-3 text-left transition-colors active:bg-line"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-semibold">
                  {c.title}
                  {c.section && <span className="font-normal text-muted"> § {c.section}</span>}
                </div>
                {c.snippet && <div className="mt-0.5 text-[13px] leading-snug text-muted line-clamp-2">{c.snippet}</div>}
              </div>
              <ChevronRight size={18} className="shrink-0 text-muted" />
            </button>
          </li>
        ))}
      </ul>
      {onRefresh && (
        <div className="mt-3 flex justify-end">
          <RefreshButton onClick={onRefresh} />
        </div>
      )}
    </div>
  );
}

/** Never strand the reader: one tap to the web, with the book's context already in the query. */
function WebSearch({ query }: { query: string }) {
  return (
    <div className="px-4 pb-5">
      <a
        href={googleUrl(query)}
        target="_blank"
        rel="noopener noreferrer"
        className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-[14px] font-medium ring-1 ring-line active:bg-surface-2"
      >
        <SearchIcon size={16} className="shrink-0 text-muted" />
        <span className="min-w-0 truncate">Search “{query}” on Google</span>
        <ExternalIcon size={13} className="shrink-0 text-muted" />
      </a>
    </div>
  );
}

function Marked({ text }: { text: MarkedText }) {
  return (
    <>
      {text.map(([t, hit], i) =>
        hit ? (
          <mark key={i} className="rounded-sm bg-accent/25 px-0.5 text-fg">
            {t}
          </mark>
        ) : (
          <span key={i}>{t}</span>
        ),
      )}
    </>
  );
}

/** No article has this title, but a section of a broader one covers it. */
function Section({
  result,
  fromCache,
  onRefresh,
  onPick,
}: {
  result: LookupResult;
  fromCache: boolean;
  onRefresh?: () => void;
  onPick: (title: string) => void;
}) {
  const section = result.section!;
  return (
    <article className="px-5 pt-4 pb-4">
      <p className="text-[12px] text-muted">No article called “{result.query}”, but it comes up in:</p>
      <h2 className="mt-1 font-serif text-[22px] leading-tight font-semibold">{result.title}</h2>
      <div className="mt-0.5 text-[14px] font-medium text-accent">§ {section.title}</div>
      <p className="mt-3 font-serif text-[16px] leading-relaxed">
        …<Marked text={section.snippet} />…
      </p>
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
        {result.pageUrl ? (
          <a
            href={result.pageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[13px] text-muted underline-offset-2 hover:underline"
          >
            Read this section on Wikipedia <ExternalIcon size={13} />
          </a>
        ) : (
          <span />
        )}
        {fromCache && onRefresh && <RefreshButton onClick={onRefresh} />}
      </div>
      {!!result.candidates?.length && (
        <>
          <p className="mt-4 text-[12px] font-semibold tracking-wider text-muted uppercase">Other matches</p>
          <ul className="mt-2 space-y-2">
            {result.candidates.map((c) => (
              <li key={`${c.title}§${c.section ?? ''}`}>
                <button
                  onClick={() => onPick(c.title)}
                  className="flex w-full items-center gap-3 rounded-xl bg-surface-2 px-4 py-2.5 text-left active:bg-line"
                >
                  <div className="min-w-0 flex-1 text-[14px] font-semibold">
                    {c.title}
                    {c.section && <span className="font-normal text-muted"> § {c.section}</span>}
                  </div>
                  <ChevronRight size={16} className="shrink-0 text-muted" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </article>
  );
}

function RefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-muted underline-offset-2 active:bg-surface-2 hover:underline"
      aria-label="Refresh from Wikipedia"
    >
      <RefreshIcon size={12} /> Refresh
    </button>
  );
}

/**
 * Images load with CORS (Wikimedia sends Access-Control-Allow-Origin: *) so the service worker
 * caches real 200 responses. Opaque no-cors responses get padded to megabytes each against
 * iOS's storage quota. If a CORS load ever fails, retry once as a plain image (not cached).
 */
function Hero({ src, portrait, compact }: { src: string; portrait?: boolean; compact?: boolean }) {
  const [mode, setMode] = useState<'cors' | 'plain' | 'failed'>('cors');
  if (mode === 'failed') return null;
  const cross = mode === 'cors' ? 'anonymous' : undefined;
  return (
    <div className={`relative overflow-hidden bg-surface-2 ${compact ? 'h-[150px]' : 'h-[200px]'}`}>
      {/* blurred backdrop fills the letterbox so portraits aren't cropped at the forehead */}
      <img
        key={mode}
        src={src}
        crossOrigin={cross}
        alt=""
        aria-hidden
        className="absolute inset-0 h-full w-full scale-125 object-cover opacity-60 blur-2xl"
      />
      <img
        key={`${mode}-main`}
        src={src}
        crossOrigin={cross}
        alt=""
        onError={() => setMode((m) => (m === 'cors' ? 'plain' : 'failed'))}
        className={`relative h-full w-full object-contain ${portrait ? 'object-top' : 'object-center'}`}
      />
    </div>
  );
}

function Article({
  result,
  fromCache,
  compact,
  onMapOpen,
  onRefresh,
}: {
  result: LookupResult;
  fromCache: boolean;
  compact?: boolean;
  onMapOpen?: () => void;
  onRefresh?: () => void;
}) {
  const [showMap, setShowMap] = useState(false);
  const coords = result.coordinates;
  return (
    <article>
      {result.imageUrl && (
        <Hero key={result.imageUrl} src={result.imageUrl} portrait={result.imageIsPortrait} compact={compact} />
      )}
      <div className="px-5 pt-4 pb-5">
        <h2 className="font-serif text-[22px] leading-tight font-semibold">{result.title}</h2>
        {result.description && <p className="mt-1 text-[13.5px] text-muted">{result.description}</p>}
        {result.extract && <p className="mt-3 font-serif text-[16px] leading-relaxed">{result.extract}</p>}

        {coords && (
          <div className="mt-4">
            <button
              onClick={() => {
                if (!showMap) onMapOpen?.();
                setShowMap((v) => !v);
              }}
              aria-expanded={showMap}
              className="inline-flex items-center gap-2 rounded-full bg-surface-2 px-3.5 py-2 text-[14px] font-medium ring-1 ring-line"
            >
              <MapIcon size={17} className="text-accent" />
              {showMap ? 'Hide map' : 'Show map'}
            </button>
            {showMap && (
              <div className="mt-3 overflow-hidden rounded-xl ring-1 ring-line">
                <iframe
                  title={`Map of ${result.title}`}
                  src={osmEmbedUrl(coords.lat, coords.lon)}
                  className="block h-[220px] w-full border-0 bg-surface-2"
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                />
                <div className="flex justify-between bg-surface-2 px-3 py-1.5 text-[11px] text-muted">
                  <span>
                    {coords.lat.toFixed(3)}, {coords.lon.toFixed(3)}
                  </span>
                  <a href={osmPageUrl(coords.lat, coords.lon)} target="_blank" rel="noopener noreferrer" className="underline">
                    © OpenStreetMap
                  </a>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="mt-5 flex items-center justify-between gap-3 border-t border-line pt-3">
          {result.pageUrl ? (
            <a
              href={result.pageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[13px] text-muted underline-offset-2 hover:underline"
            >
              Read full article on Wikipedia <ExternalIcon size={13} />
            </a>
          ) : (
            <span />
          )}
          {fromCache && (
            <span className="flex shrink-0 items-center gap-1">
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
                <CloudOffIcon size={12} /> Saved offline
              </span>
              {onRefresh && <RefreshButton onClick={onRefresh} />}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}
