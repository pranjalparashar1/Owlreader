import { useSyncExternalStore } from 'react';

/** One selection store for the whole app, fed by the main document (the PDF text layer). */
export interface SelectionState {
  text: string; // normalized, 1..80 chars, or '' when nothing short enough to look up is selected
  /** Something is selected, at any length (a whole passage still offers Clip). */
  any: boolean;
  /** A long-pressed whole page, shown as Owl's own highlight (the native selection is gone). */
  block: boolean;
}

const MAX_CHARS = 80;
const HIDE_DELAY = 350; // keep the pill alive briefly so a tap that collapses the selection still lands

let state: SelectionState = { text: '', any: false, block: false };
const listeners = new Set<() => void>();
let hideTimer: number | undefined;
let readTimer: number | undefined;

function emit(next: SelectionState) {
  if (next.text === state.text && next.any === state.any && next.block === state.block) return;
  state = next;
  listeners.forEach((l) => l());
}

function readSelection() {
  const sel = document.getSelection();
  const raw = sel && !sel.isCollapsed ? sel.toString() : '';
  const text = raw.replace(/\s+/g, ' ').trim();
  window.clearTimeout(hideTimer);
  if (!text && state.block) return; // the page highlight stands in for the selection
  if (text && text.length <= MAX_CHARS) emit({ text, any: true, block: false });
  else if (text) emit({ text: '', any: true, block: false });
  else hideTimer = window.setTimeout(() => emit({ text: '', any: false, block: false }), HIDE_DELAY);
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
  emit({ text: '', any: false, block: false });
}

/** Swaps the native selection for Owl's page highlight (see usePageSelect). */
export function setBlockSelection() {
  window.clearTimeout(hideTimer);
  emit({ text: '', any: true, block: true });
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useTextSelection(): SelectionState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

if (typeof document !== 'undefined') {
  document.addEventListener('selectionchange', schedule);
  document.addEventListener('touchend', schedule, { passive: true });
  document.addEventListener('mouseup', schedule);
  document.addEventListener('keyup', schedule);
}
