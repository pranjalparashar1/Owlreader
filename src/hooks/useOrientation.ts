import { useSyncExternalStore } from 'react';
import type { Orientation } from '../types';

const query = '(orientation: landscape)';

function subscribe(cb: () => void) {
  const mq = window.matchMedia(query);
  mq.addEventListener('change', cb);
  window.addEventListener('resize', cb);
  return () => {
    mq.removeEventListener('change', cb);
    window.removeEventListener('resize', cb);
  };
}

// Phones in landscape are short and wide; a tall desktop window counts as portrait.
const get = (): Orientation => (window.innerWidth > window.innerHeight ? 'landscape' : 'portrait');

export function useOrientation(): Orientation {
  return useSyncExternalStore(subscribe, get, () => 'portrait');
}
