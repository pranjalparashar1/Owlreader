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

**GitHub Pages:** `.github/workflows/deploy-pages.yml` builds and deploys every push to `main` to `https://<user>.github.io/Owlreader/`. It sets `BASE=/Owlreader/`, which the Vite base, the PWA manifest `scope`/`start_url` and the service worker path all follow. One-time setup: *Settings → Pages → Build and deployment → Source: GitHub Actions*.

Other static hosts (Vercel, Netlify) serve from `/`, so a plain `npm run build` is right there.

## How it fits together

| Area | Where |
| --- | --- |
| Library (import, covers, progress, delete via ⋯ or long-press) | `src/components/LibraryView.tsx`, `src/services/importBook.ts` |
| Reader chrome (theme, scrubber, font size / zoom, centre-tap toggle) | `src/components/ReaderShell.tsx` |
| EPUB engine ([foliate-js](https://github.com/johnfactotum/foliate-js), vendored) | `src/components/EpubReader.tsx`, `src/vendor/foliate-js/` |
| PDF engine (pdf.js canvas + aligned `TextLayer`, pinch/button zoom, scanned-page banner) | `src/components/PdfReader.tsx` |
| Selection across the page and every EPUB section iframe | `src/hooks/useTextSelection.ts` |
| Lookup pill and drawer (side-sheet in landscape, bottom-sheet in portrait) | `src/components/LookupPill.tsx`, `LookupDrawer.tsx`, `LookupCard.tsx` |
| Wikipedia pipeline (normalize → cache → summary → search fallback) | `src/services/wikipedia.ts` |
| IndexedDB (`books`, `files`, `lookupCache`) | `src/db/libraryDb.ts` |

Notes:

- **Reading position** is saved through one debounced `onProgressChange` funnel in `ReaderShell`, and flushed when the app is backgrounded. EPUB stores a CFI; PDF stores page and zoom.
- **Rotation** never resets the position: foliate-js re-paginates anchored to the current text range, and the PDF view keeps its page and its zoom relative to fit-width.
- **Lookup pill** fires on `pointerdown`, so the tap can't collapse the selection first, and sits in a fixed safe zone (bottom-centre portrait, bottom-right landscape) away from iOS's native callout.
- **Offline**: the app shell (including the pdf.js worker) is precached by Workbox. Lookups are cached in IndexedDB, and Wikimedia images are runtime-cached, so repeat lookups work in Airplane Mode. Maps need a connection.
- **Seams for v2**: `LookupCard` only takes a `LookupResult`, and `LookupDrawer` only takes a query, so an "On This Page" list can reuse both. All progress goes through `onProgressChange`.

Not in v1, on purpose: accounts and sync, OCR for scanned PDFs, automatic X-Ray / entity scanning, streaks and quiz export, and PDF reflow.
