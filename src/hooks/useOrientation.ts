import { useSyncExternalStore } from 'react';
import type { Orientation } from '../types';

/**
 * "Landscape" here means "wide enough for the side-sheet layout", not the device's rotation.
 * - Phones: follow the screen's orientation, so an on-screen keyboard shrinking the viewport
 *   in portrait never flips the layout.
 * - iPad Split View / Slide Over and desktop windows: use the window's own shape, and only call
 *   it landscape when it's clearly wider than tall (a near-square window keeps the bottom sheet).
 */
const WIDE_RATIO = 1.15;

function subscribe(cb: () => void) {
  const mq = window.matchMedia('(orientation: landscape)');
  mq.addEventListener('change', cb);
  window.addEventListener('resize', cb);
  screen.orientation?.addEventListener?.('change', cb);
  return () => {
    mq.removeEventListener('change', cb);
    window.removeEventListener('resize', cb);
    screen.orientation?.removeEventListener?.('change', cb);
  };
}

export function layoutOrientation(w: number, h: number, screenLandscape: boolean | null, coarse: boolean): Orientation {
  // A window narrower than it is tall is portrait whatever the screen does (split view).
  if (w <= h) return 'portrait';
  // Touch device whose screen is upright: a wide viewport means a keyboard is open, not a rotation.
  if (coarse && screenLandscape === false) return 'portrait';
  if (coarse && screenLandscape) return 'landscape';
  return w / h >= WIDE_RATIO ? 'landscape' : 'portrait';
}

const get = (): Orientation => {
  const type = screen.orientation?.type;
  const screenLandscape = type ? type.startsWith('landscape') : null;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  return layoutOrientation(window.innerWidth, window.innerHeight, screenLandscape, coarse);
};

export function useOrientation(): Orientation {
  return useSyncExternalStore(subscribe, get, () => 'portrait');
}
