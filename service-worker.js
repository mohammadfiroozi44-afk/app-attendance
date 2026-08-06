const CACHE_NAME = 'attendance-shell-v1';
const SHELL_FILES = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){ return cache.addAll(SHELL_FILES); })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== CACHE_NAME; }).map(function(k){ return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

// Network-first for the app shell so employees always get the latest version when online,
// falling back to the cached copy only if there's no connection (so the icon still opens offline).
self.addEventListener('fetch', function(event){
  if(event.request.method !== 'GET') return; // never intercept API POSTs to Apps Script
  event.respondWith(
    fetch(event.request).catch(function(){ return caches.match(event.request); })
  );
});
