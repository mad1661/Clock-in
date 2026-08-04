/*
 * Service worker for the Coburn time clock.
 *
 * Its only job is to make the app *open* when there is no signal. Without it, a
 * worker in a basement gets the browser's dinosaur and cannot even reach the
 * clock button — the offline punch queue behind it would never get a chance to
 * run.
 *
 * Deliberately hand-written and small. A generated precache manifest would have
 * to be rebuilt in lockstep with Vite's hashed filenames; runtime caching gets
 * the same result with nothing to keep in sync.
 *
 * Nothing here caches API traffic. Firestore and the callable functions manage
 * their own offline behaviour, and a stale cached response to "am I clocked in?"
 * would be worse than no response at all.
 */

const VERSION = 'v1';
const SHELL = `shell-${VERSION}`;
const ASSETS = `assets-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(['/', '/manifest.webmanifest']))
      // A failed precache must not wedge the install; runtime caching will
      // pick these up on the first successful load instead.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => !key.endsWith(VERSION)).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: try the network so a deploy is picked up promptly, fall back
  // to the cached shell when there is nothing to reach.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL).then((cache) => cache.put('/', copy));
          return response;
        })
        .catch(() => caches.match('/').then((cached) => cached ?? offlineFallback())),
    );
    return;
  }

  // Build output is content-hashed, so a cache hit is always the right answer
  // and revalidating in the background costs a worker nothing.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(ASSETS).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached ?? network;
    }),
  );
});

function offlineFallback() {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <title>Offline</title>
     <style>
       body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#eef1f6;
            color:#16202f;display:grid;place-items:center;min-height:100vh;margin:0;padding:1.5rem;text-align:center}
       h1{color:#003593}
     </style>
     <div>
       <h1>No connection</h1>
       <p>Open this page once while you have a signal, and it will work offline from then on.</p>
     </div>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 },
  );
}
