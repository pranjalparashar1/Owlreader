# OwlReader

A mobile-first PWA for reading **text-layer PDF** books on iPhone, with **tap-to-lookup**: select a name or place, tap the floating *Look up* pill, and get a photo, a 2–3 sentence summary and a map in a drawer, without leaving the book.

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
| Reader chrome (scrubber, centre-tap toggle) and the Aa settings menu (theme, Pages / Scroll, zoom %) | `src/components/ReaderShell.tsx`, `ReaderSettings.tsx` |
| Crash screen (Reload / Back to Library) | `src/components/ErrorBoundary.tsx` |
| PDF engine (native scroll-snap paging or vertical scroll, virtualized pages, pinch/button zoom, scanned-page banner) | `src/components/PdfReader.tsx` |
| Live scrubber preview (throttled micro-thumbnails, 48-entry LRU, cancels superseded renders) | `ReaderShell.tsx`, `PdfReader.tsx` (`renderThumbnail`) |
| Layout orientation (side sheet vs bottom sheet; screen orientation on phones, window shape for split view / desktop) | `src/hooks/useOrientation.ts` |
| Text selection store (feeds the Look up pill) | `src/hooks/useTextSelection.ts` |
| Lookup pill and drawer (side-sheet in landscape, bottom-sheet in portrait) | `src/components/LookupPill.tsx`, `LookupDrawer.tsx`, `LookupCard.tsx` |
| Wikipedia pipeline (normalize → cache → summary → search fallback; 8 s timeout, 429/5xx shown as Retry) | `src/services/wikipedia.ts` |
| IndexedDB (`books`, `files`, `lookupCache`) | `src/db/libraryDb.ts` |

Notes:

- **Reading position** is saved through one debounced `onProgressChange` funnel in `ReaderShell`, and flushed when the app is backgrounded. It stores the page and zoom.
- **Rotation** never resets the position: the PDF view keeps its page and its zoom relative to fit-width.
- **Smooth scrolling on iPhone**: PDF paging is a CSS scroll-snap carousel and Scroll mode is a plain vertical scroller, so swipes and momentum run on the compositor. pdf.js work is queued for when scrolling stops. Pinch-zoom previews with a GPU transform and re-renders once at the end.
  - *Two-pass canvases*: pages first render at ≤2× DPR / 2.2 MP; the current page gets a sharp pass (full DPR, ≤4.5 MP) after 300 ms of stillness.
  - *Lazy page sizes*: only page 1 and the start page are measured on open; real sizes for current ± 20 pages are probed while idle, and the restore effect keeps the reading position fixed when a page above changes height.
  - *Virtualized Scroll mode*: ~17 page boxes around the current page, with spacers (drawn as blank pages) for the rest. Pages mode uses `content-visibility: auto` on off-screen slots.
  - *Dark and sepia* are baked into each bitmap with canvas blend modes (`difference` + `hue` for dark, `multiply` for sepia), so there's no CSS filter for the compositor to re-run. iOS Safari has no canvas `ctx.filter`, which pdf.js's `pageColors` needs.
- **Lookup pill** fires on `pointerdown`, so the tap can't collapse the selection first, and sits in a fixed safe zone (bottom-centre portrait, bottom-right landscape) away from iOS's native callout.
- **Offline**: the app shell (including the pdf.js worker) is precached by Workbox. Lookups are cached in IndexedDB, and Wikimedia images are runtime-cached, so repeat lookups work in Airplane Mode. Maps need a connection.
- **Seams for v2**: `LookupCard` only takes a `LookupResult`, and `LookupDrawer` only takes a query, so an "On This Page" list can reuse both. All progress goes through `onProgressChange`.

**PDF only since 1.2.** Books imported as other formats by 1.0/1.1 stay in IndexedDB untouched and show in the library as "Unsupported · tap to delete".

Not in v1, on purpose: accounts and sync, OCR for scanned PDFs, automatic X-Ray / entity scanning, streaks and quiz export, and PDF reflow.
