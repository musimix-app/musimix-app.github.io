// MusiMix — service worker : l'appli fonctionne hors ligne une fois ouverte.
// Les morceaux sont stockés dans l'appareil (IndexedDB), pas dans ce cache.
const VERSION = 'musimix-4.22.2';
const SHELL = [
  './',
  'assets/fonts/Atkinson.ttf',
  'assets/fonts/Fraunces.ttf',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/app-192.png',
  'assets/icons/app-512.png',
  'assets/icons/app-maskable-192.png',
  'assets/icons/app-maskable-512.png',
  'css/app.css',
  'data/guitar.json',
  'index.html',
  'js/db.js',
  'js/diagrams.js',
  'js/engine.js',
  'js/main.js',
  'js/midi.js',
  'js/synth.js',
  'js/wav.js',
  'js/zoom.js',
  'js/pitch-worklet.js',
  'js/print.js',
  'js/render.js',
  'js/sheet.js',
  'js/songs.js',
  'js/studio.js',
  'js/sync.js',
  'js/levels.js',
  'js/tuner.js',
  'js/capo.js',
  'js/midi-input.js',
  'js/surface.js',
  'js/diag.js',
  'js/take.js',
  'js/opus.js',
  'js/impro.js',
  'js/analyze.js',
  'js/prepare.js',
  'js/separate.js',
  'js/vendor/unblend/audio-processor.js',
  'js/vendor/unblend/constants.js',
  'js/vendor/unblend/index.js',
  'js/vendor/unblend/istft-client.js',
  'js/vendor/unblend/model-artifacts.js',
  'js/vendor/unblend/model-fetch.js',
  'js/vendor/unblend/model-metadata.js',
  'js/vendor/unblend/onnx-client.js',
  'js/vendor/unblend/overlap-accumulator.js',
  'js/vendor/unblend/pipeline.js',
  'js/vendor/unblend/separator.js',
  'js/vendor/unblend/stft-client.js',
  'js/vendor/unblend/vendor/fft.js',
  'js/vendor/unblend/webgpu-checks.js',
  'js/vendor/unblend/workers/istft-worker.js',
  'js/vendor/unblend/workers/onnx-worker.js',
  'js/vendor/unblend/workers/stft-worker.js',
  'js/theory.js',
  'js/ui.js',
  'js/views/editor.js',
  'js/views/library.js',
  'js/views/player.js',
  'js/views/chord-edit.js',
  'js/views/shared.js',
  'js/zip.js',
  'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;                 // Studio, LRCLIB : jamais en cache
  if (/\.(mp3|wav|flac|m4a|ogg)$/i.test(url.pathname)) return; // audio de démo : réseau
  if (url.pathname.includes('/api/') || url.pathname.endsWith('/bridge')) return;
  // réseau d'abord (mises à jour immédiates), cache si hors ligne
  e.respondWith(
    fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});
