import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// Set BASE=/owl/ when deploying to GitHub Pages project sites.
const base = process.env.BASE ?? '/';

export default defineConfig({
  base,
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // 'prompt': a new version waits for the reader to tap Update (see src/lib/pwaUpdate.ts)
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Owl',
        short_name: 'Owl',
        description: 'Read PDF books with tap-to-lookup photos, summaries and maps.',
        theme_color: '#1c1917',
        background_color: '#faf7f2',
        display: 'standalone',
        orientation: 'any',
        start_url: base,
        scope: base,
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell (including the PDF.js worker) is precached so the reader opens offline.
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            // Lookup photos, so cached lookups still show their image in Airplane Mode.
            // Images load with crossOrigin="anonymous", so only real 200s are cached: opaque
            // (status 0) responses are padded to megabytes each against iOS's storage quota.
            // New cache name: the 1.x opaque entries in 'wiki-images' are deleted on startup.
            urlPattern: ({ url }) => url.hostname === 'upload.wikimedia.org',
            handler: 'CacheFirst',
            options: {
              cacheName: 'wiki-images-v2',
              expiration: { maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 90, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  build: {
    target: ['es2022', 'safari15'],
  },
  worker: { format: 'es' },
});
