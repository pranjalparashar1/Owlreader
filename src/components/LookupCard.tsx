import { useState } from 'react';
import type { LookupResult } from '../types';
import { osmEmbedUrl, osmPageUrl } from '../services/wikipedia';
import { ChevronRight, CloudOffIcon, ExternalIcon, MapIcon } from './icons';

interface Props {
  result: LookupResult;
  fromCache: boolean;
  onPickCandidate: (title: string) => void;
  /** Shorter hero image, for the half-height portrait sheet. */
  compact?: boolean;
}

/**
 * Pure renderer for one lookup result. Deliberately knows nothing about text selection,
 * so a future "On This Page" drawer can render auto-extracted entities with it as-is.
 */
export default function LookupCard({ result, fromCache, onPickCandidate, compact }: Props) {
  if (result.type === 'disambiguation') return <Candidates result={result} onPick={onPickCandidate} />;
  if (result.type === 'not_found') {
    return (
      <div className="px-5 py-8 text-center">
        <p className="font-serif text-[18px] font-semibold">No Wikipedia article found</p>
        <p className="mt-2 text-[14px] text-muted">
          Nothing matched “{result.query}”. Try adding context in the search box above, like a first name or a place.
        </p>
      </div>
    );
  }
  return <Article result={result} fromCache={fromCache} compact={compact} />;
}

function Candidates({ result, onPick }: { result: LookupResult; onPick: (title: string) => void }) {
  return (
    <div className="px-4 pt-3 pb-5">
      <p className="px-1 text-[13px] text-muted">
        “{result.query}” could mean several things. Pick one:
      </p>
      <ul className="mt-3 space-y-2">
        {result.candidates?.map((c) => (
          <li key={c.title}>
            <button
              onClick={() => onPick(c.title)}
              className="flex w-full items-center gap-3 rounded-xl bg-surface-2 px-4 py-3 text-left transition-colors active:bg-line"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-semibold">{c.title}</div>
                {c.snippet && <div className="mt-0.5 text-[13px] leading-snug text-muted line-clamp-2">{c.snippet}</div>}
              </div>
              <ChevronRight size={18} className="shrink-0 text-muted" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Hero({ src, portrait, compact }: { src: string; portrait?: boolean; compact?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <div className={`relative overflow-hidden bg-surface-2 ${compact ? 'h-[150px]' : 'h-[200px]'}`}>
      {/* blurred backdrop fills the letterbox so portraits aren't cropped at the forehead */}
      <img src={src} alt="" aria-hidden className="absolute inset-0 h-full w-full scale-125 object-cover opacity-60 blur-2xl" />
      <img
        src={src}
        alt=""
        onError={() => setFailed(true)}
        className={`relative h-full w-full object-contain ${portrait ? 'object-top' : 'object-center'}`}
      />
    </div>
  );
}

function Article({ result, fromCache, compact }: { result: LookupResult; fromCache: boolean; compact?: boolean }) {
  const [showMap, setShowMap] = useState(false);
  const coords = result.coordinates;
  return (
    <article>
      {result.imageUrl && <Hero key={result.imageUrl} src={result.imageUrl} portrait={result.imageIsPortrait} compact={compact} />}
      <div className="px-5 pt-4 pb-5">
        <h2 className="font-serif text-[22px] leading-tight font-semibold">{result.title}</h2>
        {result.description && <p className="mt-1 text-[13.5px] text-muted">{result.description}</p>}
        {result.extract && <p className="mt-3 font-serif text-[16px] leading-relaxed">{result.extract}</p>}

        {coords && (
          <div className="mt-4">
            <button
              onClick={() => setShowMap((v) => !v)}
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
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
              <CloudOffIcon size={12} /> Saved offline
            </span>
          )}
        </div>
      </div>
    </article>
  );
}
