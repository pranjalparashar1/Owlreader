# OwlReader

A mobile-first PWA for reading **EPUB** and **text-layer PDF** books on iPhone, with **tap-to-lookup**: select a name or place, tap the floating *Look up* pill, and get a photo, a 2–3 sentence summary and a map in a drawer, without leaving the book.

Everything runs in the browser. Books, reading positions and past lookups are stored on the device in IndexedDB; there is no backend and no account.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
npm run preview    # serve dist/ (service worker enabled)
```

To try it on an iPhone, open the deployed site in Safari, then *Share → Add to Home Screen*.

**GitHub Pages:** `.github/workflows/deploy-pages.yml` builds every push to `main` with `BASE=/Owlreader/` (the Vite base, the PWA manifest `scope`/`start_url` and the service worker path all follow it) and pushes the built site to the `gh-pages` branch. One-time setup: *Settings → Pages → Source: Deploy from a branch → Branch: `gh-pages`, folder `/ (root)`*. Don't point Pages at `main`: that serves the unbuilt source and shows a blank page.

Other static hosts (Vercel, Netlify) serve from `/`, so a plain `npm run build` is right there.

## How it fits together

| Area | Where |
| --- | --- |
| Library (import, covers, progress, delete via ⋯ or long-press) | `src/components/LibraryView.tsx`, `src/services/importBook.ts` |
| Reader chrome (scrubber, centre-tap toggle) and the Aa settings menu (theme, Pages / Scroll, text size / zoom) | `src/components/ReaderShell.tsx`, `ReaderSettings.tsx` |
| EPUB engine ([foliate-js](https://github.com/johnfactotum/foliate-js), vendored) | `src/components/EpubReader.tsx`, `src/vendor/foliate-js/` |
| PDF engine (native scroll-snap paging or vertical scroll, virtualized pages, pinch/button zoom, scanned-page banner) | `src/components/PdfReader.tsx` |
| Selection across the page and every EPUB section iframe | `src/hooks/useTextSelection.ts` |
| Lookup pill and drawer (side-sheet in landscape, bottom-sheet in portrait) | `src/components/LookupPill.tsx`, `LookupDrawer.tsx`, `LookupCard.tsx` |
| Wikipedia pipeline (normalize → cache → summary → search fallback) | `src/services/wikipedia.ts` |
| IndexedDB (`books`, `files`, `lookupCache`) | `src/db/libraryDb.ts` |

Notes:

- **Reading position** is saved through one debounced `onProgressChange` funnel in `ReaderShell`, and flushed when the app is backgrounded. EPUB stores a CFI; PDF stores page and zoom.
- **Rotation** never resets the position: foliate-js re-paginates anchored to the current text range, and the PDF view keeps its page and its zoom relative to fit-width.
- **Smooth scrolling on iPhone**: PDF paging is a CSS scroll-snap carousel and Scroll mode is a plain vertical scroller, so swipes and momentum run on the compositor. Only nearby pages hold a canvas, and pdf.js renders are queued for when scrolling stops. Pinch-zoom previews with a GPU transform and re-renders once at the end. Dark and sepia are drawn by pdf.js (`pageColors`) instead of a CSS filter.
- **Lookup pill** fires on `pointerdown`, so the tap can't collapse the selection first, and sits in a fixed safe zone (bottom-centre portrait, bottom-right landscape) away from iOS's native callout.
- **Offline**: the app shell (including the pdf.js worker) is precached by Workbox. Lookups are cached in IndexedDB, and Wikimedia images are runtime-cached, so repeat lookups work in Airplane Mode. Maps need a connection.
- **Seams for v2**: `LookupCard` only takes a `LookupResult`, and `LookupDrawer` only takes a query, so an "On This Page" list can reuse both. All progress goes through `onProgressChange`.

Not in v1, on purpose: accounts and sync, OCR for scanned PDFs, automatic X-Ray / entity scanning, streaks and quiz export, and PDF reflow.
