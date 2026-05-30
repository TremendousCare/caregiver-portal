import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    // ─── Caregiver PWA service worker ───
    // Scoped to `/care` ONLY so the office/admin app at `/` is never
    // controlled by a service worker (keeps the production blast radius
    // limited to the caregiver rollout). The SW file is emitted at the
    // site root but registered with a narrower `/care` scope, which the
    // platform allows without a Service-Worker-Allowed header.
    //
    // registerType 'prompt': we never auto-skip-waiting. A new version
    // waits until the caregiver taps "Update" — so assets can't be
    // swapped mid-shift. The static care-manifest.webmanifest is kept
    // as the install manifest (manifest: false here), so we only own the
    // service worker, not the manifest.
    VitePWA({
      registerType: 'prompt',
      scope: '/care',
      manifest: false,
      injectRegister: false,
      filename: 'sw.js',
      workbox: {
        // Pull in the push / notificationclick handlers (Web Push for
        // shift reminders). Plain script imported into the generated SW.
        importScripts: ['push-sw.js'],
        // Precache only the navigation shell. We deliberately do NOT
        // precache the whole bundle — caregivers shouldn't download the
        // heavy admin chunks. JS/CSS chunks are runtime-cached on first
        // visit (StaleWhileRevalidate) so the app works offline after the
        // caregiver opens it once online (e.g. at the start of their day).
        globPatterns: ['**/index.html'],
        navigateFallback: '/index.html',
        navigateFallbackAllowlist: [/^\/care/],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: false,
        runtimeCaching: [
          {
            // App code + workers: serve cached, revalidate in background.
            urlPattern: ({ request }) =>
              ['script', 'style', 'worker'].includes(request.destination),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'tc-app-assets',
              expiration: { maxEntries: 100, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
          {
            // Icons / fonts shipped with the app.
            urlPattern: ({ request }) =>
              request.destination === 'image' || request.destination === 'font',
            handler: 'CacheFirst',
            options: {
              cacheName: 'tc-static',
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 24 * 60 * 60 },
            },
          },
          {
            // Google Fonts stylesheet + font files.
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tc-google-fonts',
              expiration: { maxEntries: 20, maxAgeSeconds: 365 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
        // Never let the SW cache Supabase API/auth/function traffic — those
        // must always hit the network. Offline data resilience for clock
        // events is handled by the app-level outbox, not the SW cache.
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 3000,
    open: true,
  },
});
