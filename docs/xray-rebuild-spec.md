# X-Ray rebuild spec (for Owl 2.x)

X-Ray shipped in Owl 1.6.1 (PR #11) and was removed in 1.8.4. This document is everything needed to
rebuild it, under a new name, once Owl 1.x is polished. The last commit that still contains the full
implementation is `23927ca` on `main` (Owl 1.8.3). `git show 23927ca:<path>` recovers any file listed below.

## 1. What it did

X-Ray answered "who or what is this, and where else does the book mention it?" without leaving the page.

1. **On This Page.** A top-bar button (lens-over-page icon, label "X-Ray this page") opened the lookup
   drawer on a list of the people, places, organisations and capitalised terms on the current page,
   most mentioned first, as chips with a coloured kind dot (person sky, place emerald, organisation
   violet, term amber). Tapping a chip ran a normal Wikipedia lookup pushed on top of the list, so Back
   returned to it. When the book had a whole-book index, each chip also showed how many pages mention it.
2. **Whole book.** Opt-in per book. Indexed every page in the background and saved a checkpoint after each
   batch, so it resumed after the app was closed. Progress showed as a thin bar under the setting.
3. **In This Book card.** With an index, any lookup of an indexed term (from a text selection or the list)
   showed a card above the Wikipedia result: "First mentioned on p. N: “sentence”", "Mentioned on K pages",
   and a pill per page (first 24, then "+N more"). Tapping a pill closed the drawer and jumped there.
4. **Return pill.** After a jump, a floating pill "p. N" (with a dismiss ×) under the status bar took the
   reader back to where they were. It appeared only while the drawer was closed, moved down 50px when the
   chrome was showing, and cleared after use.
5. **Lookup ranking.** When the drawer was opened from the X-Ray list, the list's labels were the context
   terms used to rank disambiguation candidates (`rankCandidates(result, terms)` in
   `src/services/wikipedia.ts`). Otherwise the names near the selection were used. That second path is kept
   in 1.8.4 and needs no X-Ray.

Settings: Reading settings → "X-Ray" segmented control: **Off / Page / Book**.

- Off: no extraction, no worker, no index read, button hidden.
- Page: button shown; extraction only on tap. An index built earlier still answered In This Book.
- Book: Page, plus whole-book indexing for this book.
  The global on/off lived in `Settings.xray` (`'off' | 'on'`, default `'on'`, localStorage key
  `owl.settings.v1`); whole-book was `BookRecord.xrayWholeBook?: boolean`.

## 2. Architecture

```
ReaderShell ──tap──▶ getPageText(page) ──▶ features/xray/client.ts ──postMessage──▶ workers/xrayWorker.ts
     │                                                                              (compromise + heuristics)
     └─(Book mode)─▶ features/xray/indexer.ts ──getPageText(n, {idle:true})──▶ PdfReader idle queue
                              │
                              └─▶ IndexedDB `bookIndex` store (checkpoint per 10 pages)
LookupDrawer ◀── inBook(term) = features/xray/find.ts(findEntity) over the loaded BookIndexRecord
```

- Everything X-Ray was a dynamic `import()`: normal reading never parsed it. A test checked that
  `xrayWorker` was not in `performance.getEntriesByType('resource')` until first use.
- Worker: `new Worker(new URL('../../workers/xrayWorker.ts', import.meta.url), { type: 'module', name: 'xray' })`,
  Vite `worker: { format: 'es' }`. One worker, created lazily, request/response matched by an incrementing id.
  On `onerror` all pending requests rejected and the worker was terminated (recreated on next use).
- Messages:
  - `{ id, type: 'page', text }` → `{ id, type: 'page', entities: ExtractedEntity[] }`
  - `{ id, type: 'pages', pages: [{ page, text }] }` → `{ id, type: 'pages', pages: [{ page, entities }] }`
  - any failure → `{ id, type: 'error', message }`
- Page text came from pdf.js `getTextContent()` via `pageTextFromItems()` (kept in `src/lib/terms.ts`):
  items joined with spaces, `hasEOL` → newline, line-end hyphens between lowercase letters joined.

## 3. Extraction algorithm (worker)

Input: one page's text. Output: `ExtractedEntity { key, label, kind, count, sentence }` sorted by count desc,
then kind rank (person < place < org < term), then label.

1. `proseText(text)` (kept in `src/lib/terms.ts`): drop blank lines, page numbers (≤8 chars of digits,
   dashes, dots or roman numerals), ALL-CAPS running headers (≥4 letters, ≤8 words); a short line
   (≤6 words, capitalised, no closing punctuation) is a heading and gets a full stop so it doesn't run
   into the next sentence.
2. NLP tags with [compromise](https://github.com/spencermountain/compromise) 14.19 (rule-based, ~200 kB,
   no model): `doc.people()`, `doc.places()`, `doc.organizations()` → `out('array')`. Each label cleaned
   (strip possessive `'s`, strip leading/trailing non-letters, collapse spaces), kept only if length > 1,
   starts uppercase and is not a stop word. First kind wins per lowercase key.
3. Heuristic candidates: `capitalisedTerms(text)` (kept in `src/lib/terms.ts`): runs of capitalised words,
   acronyms (`\p{Lu}{2,}\d*`) and CamelCase, allowing joiners `of de von van da la the` inside a run
   ("Bank of England") but not "and"; stop words trimmed from both ends; a single plain capitalised word at
   a sentence start doesn't count (acronyms and CamelCase do). Count per lowercase key.
4. Kind for each heuristic term: the tagged kind for the same key; else, if a tagged key overlaps it
   (substring either way), prefer place, then org, then person ("Santa Clara" picks up compromise's
   "Santa" → place; "Clara" alone as person is weaker); else `term`. Keys starting with a digit dropped.
5. Tagged entities the heuristic missed: added if no heuristic key contains them, counted by substring
   occurrences in the lowercased text, label taken from the first occurrence's original casing.
6. `sentence`: the first sentence containing the label (sentence split: flatten newlines, match
   `[^.!?]+(?:[.!?]+["'”’)\]]*|$)`), truncated to 277 chars + "…" past 280.
7. The page list showed the top 40 as `{ label, kind, count }`.

Stop words (also kept in `terms.ts` as `isStopWord`): articles, pronouns, conjunctions, common sentence
starters, book furniture (chapter, page, part, section, figure, table, contents, index, introduction,
preface, appendix, notes, acknowledg(e)ments, prologue, epilogue), titles (mr mrs ms dr st) and
month/day names.

Known gap: a name that only ever starts a sentence ("Sega paid…") was missed unless compromise tagged it.

## 4. Whole-book index

```ts
interface BookEntity {
  label: string;
  kind: 'person' | 'place' | 'org' | 'term';
  pages: number[];
  firstPage: number;
  firstSentence: string;
}
interface BookIndexRecord {
  bookId: string;
  indexedPages: number;
  totalPages: number;
  entities: Record<string, BookEntity>;
  updatedAt: number;
}
```

- Store: IndexedDB `owlreader` v2 added object store `bookIndex` (keyPath `bookId`). Removed in v4 (1.8.4).
- Indexer (`startIndexing({ bookId, totalPages, getText, onProgress }) → stop()`):
  - Loads the saved record; restarts from scratch if `totalPages` changed.
  - Batches of 10 pages: text fetched one page at a time through the reader's **idle queue** (priority 20,
    lowest: after visible canvases, sharp passes, size probes and previews; never while scrolling), then one
    `pages` message to the worker, merge, prune, `put` the record, `onProgress({...record})`.
  - Merge: new key → `{ label, kind, pages:[page], firstPage: page, firstSentence }`; existing → append page
    if not already last; upgrade kind from `term` to a tagged kind.
  - Prune: past 6000 keys, drop `term` entries seen on only one page.
  - Stop flag checked between every await; errors swallowed (last checkpoint stands).
- The shell started indexing only when X-Ray was on, the book was opted in, and the page count was known.
- Lookup: `findEntity(record, query)` = `entities[q]` or `entities[q without trailing 's]`, `q` lowercased
  and trimmed.
- Deleting a book deleted its index row in the same transaction as `books` and `files`.

Fixture-scale numbers (Chromium emulation): about 70 ms from tap to the On This Page list, including the
drawer; the 12-page `chronicle.pdf` fully indexed in well under 20 s.

## 5. Why it was removed, and what a rebuild must do differently

1. **It competed with the reader.** Page text for indexing was read on the main thread (`getTextContent`
   parses on the main thread in pdf.js) through the idle queue. The idle queue paused for scrolling but
   **not for pinch-zoom**, so on long books whole-book indexing ran during zoom gestures. 1.8.4 pauses the
   queue for every gesture, but a rebuild should get text off the main thread entirely: open its own
   pdf.js document in a worker (pdf.js can run without a canvas for `getTextContent`) or extract all text
   once at import time and store it.
2. **Too much UI for the value.** A top-bar button, a three-way setting, a progress bar, a card, a return
   pill. Follow the 1.8.2 design rule (Musk's 5 steps): one entry point, no settings, no descriptions.
   Suggested shape: no toggle; index silently at import (or first open) in a worker; surface "In this
   book" only inside the existing lookup drawer, as one line with a page count that expands.
3. **Global default was on.** Even with Book off, Page mode loaded the stored index on every open.
4. Keep: lazy loading of the NLP code, the checkpointed/resumable index, the possessive-stripping lookup,
   the dot colours, Back returning to the list, and ranking disambiguation candidates by the names on the
   page.

## 6. Rebuild checklist

- [ ] New name and icon (iOS-native style, SF Symbols look).
- [ ] New IDB store under a new name in a new DB version (v4 deleted `bookIndex`; don't reuse the name).
      Upgrades must only add or delete stores, never touch `books`, `files`, `lookupCache` or `clips`.
- [ ] Text extraction off the main thread; zero work while any gesture or scroll is active.
- [ ] Delete the index row with its book (one transaction with `books`/`files`/`clips`).
- [ ] Re-add `compromise` (or a lighter tagger) only inside the worker chunk.
- [ ] Tests to restore (from `tests/e2e/xray.spec.ts` at `23927ca`): list shows Jensen Huang (Person),
      Nvidia, Santa Clara, and no "Chapter"; tap looks up and Back returns; nothing loads before first use;
      index resumes across a reload; Bumpgate card says "First mentioned on p. 3", quotes "later dubbed
      Bumpgate", "Mentioned on 4 pages", jump to p. 7 and return to p. 4; index deleted with its book.
- [ ] Real iPhone: indexing a 300+ page book while flinging and pinching stays at full frame rate.

## 7. Files removed in 1.8.4

`src/features/xray/{client,find,indexer}.ts`, `src/workers/xrayWorker.ts`, `tests/e2e/xray.spec.ts`
(its lookup tests moved to `tests/e2e/lookup-search.spec.ts`), the X-Ray parts of `ReaderShell.tsx`,
`LookupDrawer.tsx` (`XrayList`, `InThisBook`), `ReaderSettings.tsx`, `icons.tsx` (`XrayIcon`,
`ReturnIcon`), `types/index.ts` (`EntityKind`, `PageEntity`, `BookEntity`, `BookIndexRecord`,
`xrayWholeBook`), `libraryDb.ts` (`getBookIndex`, `putBookIndex`, `deleteBookIndex`), `settings.ts`
(`xray`), `terms.ts` (`sentences`), the `idle` option of `getPageText`, and the `compromise` dependency.
