// Service worker: lets the app open offline and launch instantly from the home screen.
// AI models are cached separately by Transformers.js in its own Cache Storage.

const CACHE_PREFIX = 'airpod-translator-';
const CACHE = `${CACHE_PREFIX}v1`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './vad/vad.worklet.bundle.min.js',
  './vad/silero_vad_v5.onnx',
  './vad/ort-wasm-simd-threaded.wasm',
  './vad/ort-wasm-simd-threaded.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }
  event.respondWith(request.mode === 'navigate' ? networkFirst(request) : cacheFirst(request));
});

/** Pages: try the network so updates arrive, fall back to the cached copy when offline. */
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    return (await cache.match(request)) ?? (await cache.match('./index.html')) ?? Promise.reject(error);
  }
}

/** Static files: filenames are content-hashed or versioned, so a cached copy is always valid. */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    cache.put(request, response.clone());
  }
  return response;
}
