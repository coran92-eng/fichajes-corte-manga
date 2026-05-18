const CACHE_NAME = 'fichaje-v3';
const urlsToCache = [
  '/',
  '/index.html',
  '/admin.html',
  '/manifest.json'
];

// Instalar service worker
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(urlsToCache);
      })
      .catch(err => {
        console.log('Cache install error:', err);
      })
  );
  self.skipWaiting();
});

// Activar service worker
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Interceptar peticiones — estrategia network-first:
// siempre intenta la red (para servir la última versión tras cada deploy)
// y solo usa la caché como respaldo cuando no hay conexión.
self.addEventListener('fetch', event => {
  // Las llamadas a la API y config siempre van a la red, nunca a caché
  if (event.request.url.includes('/api/') || event.request.url.includes('config.json')) {
    return;
  }

  // Solo cachear GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Guardar una copia fresca en caché para uso offline
        if (response && response.status === 200 && response.type === 'basic') {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      })
      .catch(() => {
        // Sin conexión: servir desde caché si existe
        return caches.match(event.request).then(cached => {
          if (cached) return cached;
          return new Response('Offline - Por favor, verifica tu conexión', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: new Headers({ 'Content-Type': 'text/plain' })
          });
        });
      })
  );
});
