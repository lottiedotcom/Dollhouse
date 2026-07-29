const CACHE_NAME = 'manager-cache-v4'; // Bumping version forces the app to refresh
const urlsToCache = [
    '/',
    '/index.html',
    '/queue.js',
    '/kaomoji.js',
    '/icon.jpg'
];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache)));
    self.skipWaiting(); // Force the new worker to take over immediately
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
            );
        })
    );
    self.clients.claim(); // Claim control instantly
});

self.addEventListener('fetch', event => {
    // STRICT RULE: Never, ever cache database API calls!
    if (event.request.url.includes('supabase.co') || event.request.url.includes('upstash.io')) {
        return; // Bypass the service worker completely for databases
    }
    
    event.respondWith(
        caches.match(event.request).then(response => {
            return response || fetch(event.request);
        })
    );
});
