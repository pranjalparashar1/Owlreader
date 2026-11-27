import { useSyncExternalStore } from 'react';

/** One selection store for the whole app, fed by the main document (the PDF text layer). */
export interface SelectionState {
  text: string; // normalized, 1..80 chars, or '' when nothing usable is selected
}

const MAX_CHARS = 80;
const HIDE_DELAY = 350; // keep the pill alive briefly so a tap that collapses the selection still lands

let state: SelectionState = { text: '' };
const listeners = new Set<() => void>();
let hideTimer: number | undefined;
let readTimer: number | undefined;

function emit(next: SelectionState) {
  if (next.text === state.text) return;
  state = next;
  listeners.forEach((l) => l());
}

function readSelection() {
  const sel = document.getSelection();
  const raw = sel && !sel.isCollapsed ? sel.toString() : '';
  const text = raw.replace(/\s+/g, ' ').trim();
  window.clearTimeout(hideTimer);
  if (text && text.length <= MAX_CHARS) emit({ text });
  else hideTimer = window.setTimeout(() => emit({ text: '' }), text ? 0 : HIDE_DELAY);
}

function schedule() {
  window.clearTimeout(readTimer);
  readTimer = window.setTimeout(readSelection, 120);
}

/** The live selection range, so 'both' lookup mode can put it back after the drawer closes. */
export function saveSelectionRange(): Range | null {
  const sel = document.getSelection();
  return sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0).cloneRange() : null;
}

export function restoreSelectionRange(range: Range | null) {
  if (!range || !range.startContainer.isConnected || !range.endContainer.isConnected) return;
  const sel = document.getSelection();
  if (!sel || !sel.isCollapsed) return; // the reader already selected something else
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Clears the current selection (and with it iOS's native callout bar). */
export function clearTextSelection() {
  try {
    document.getSelection()?.removeAllRanges();
  } catch {
    /* ignore */
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

if (typeof document !== 'undefined') {
  document.addEventListener('selectionchange', schedule);
  document.addEventListener('touchend', schedule, { passive: true });
  document.addEventListener('mouseup', schedule);
  document.addEventListener('keyup', schedule);
}
