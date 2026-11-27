import { useSyncExternalStore } from 'react';
import { registerSW } from 'virtual:pwa-register';

/**
 * Service-worker updates wait for the reader's OK instead of reloading under them: when a new
 * version has installed, `useUpdateAvailable()` turns true and `applyUpdate()` activates it
 * and reloads. Checks run on start, every hour, and whenever the app comes back to the
 * foreground (iOS Home Screen apps are resumed, not relaunched, so a stale worker could
 * otherwise linger for days).
 */
let available = false;
const listeners = new Set<() => void>();
let update: ((reload?: boolean) => Promise<void>) | null = null;

export function initPwaUpdates() {
  update = registerSW({
    immediate: true,
    onNeedRefresh() {
      available = true;
      listeners.forEach((l) => l());
    },
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      const check = () => reg.update().catch(() => {});
      setInterval(check, 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
    },
  });
}

export function applyUpdate() {
  return update?.(true);
}

export function dismissUpdate() {
  available = false;
  listeners.forEach((l) => l());
}

export function useUpdateAvailable() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => available,
    () => false,
  );
}
