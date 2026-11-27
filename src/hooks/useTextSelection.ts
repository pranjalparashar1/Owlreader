import { useSyncExternalStore } from 'react';

/**
 * One selection store for the whole app. The main document (PDF text layer) is
 * registered at startup; the EPUB reader registers each section iframe's document
 * as foliate-js loads it, since selections inside iframes never reach the parent.
 */
export interface SelectionState {
  text: string; // normalized, 1..80 chars, or '' when nothing usable is selected
}

const MAX_CHARS = 80;
const HIDE_DELAY = 350; // keep the pill alive briefly so a tap that collapses the selection still lands

let state: SelectionState = { text: '' };
let activeDoc: Document | null = null;
const listeners = new Set<() => void>();
const registered = new WeakSet<Document>();
let hideTimer: number | undefined;
let readTimer: number | undefined;

function emit(next: SelectionState) {
  if (next.text === state.text) return;
  state = next;
  listeners.forEach((l) => l());
}

function readSelection(doc: Document) {
  const sel = doc.getSelection();
  const raw = sel && !sel.isCollapsed ? sel.toString() : '';
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text && text.length <= MAX_CHARS) {
    window.clearTimeout(hideTimer);
    activeDoc = doc;
    emit({ text });
  } else if (doc === activeDoc || !state.text) {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => emit({ text: '' }), text ? 0 : HIDE_DELAY);
  }
}

function schedule(doc: Document) {
  window.clearTimeout(readTimer);
  readTimer = window.setTimeout(() => readSelection(doc), 120);
}

export function registerSelectionDocument(doc: Document) {
  if (registered.has(doc)) return;
  registered.add(doc);
  const onChange = () => schedule(doc);
  doc.addEventListener('selectionchange', onChange);
  doc.addEventListener('touchend', onChange, { passive: true });
  doc.addEventListener('mouseup', onChange);
  doc.addEventListener('keyup', onChange);
}

/** Clears the current selection (and with it iOS's native callout bar). */
export function clearTextSelection() {
  try {
    activeDoc?.getSelection()?.removeAllRanges();
  } catch {
    /* document may be gone */
  }
  window.clearTimeout(hideTimer);
  emit({ text: '' });
}

export function getSelectionText() {
  return state.text;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useTextSelection(): SelectionState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

if (typeof document !== 'undefined') registerSelectionDocument(document);
