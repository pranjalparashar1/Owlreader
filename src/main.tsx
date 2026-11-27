import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';

registerSW({ immediate: true });

// 1.4 and earlier cached Wikipedia images as opaque responses, which iOS pads heavily against
// the storage quota. 1.5 caches CORS responses in 'wiki-images-v2'; drop the old cache.
if ('caches' in window) caches.delete('wiki-images').catch(() => {});

// iOS Safari ignores maximum-scale; block its page pinch-zoom so the reader chrome never scales.
// (PDF zoom is handled inside the PDF reader.)
document.addEventListener('gesturestart', (e) => e.preventDefault());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
