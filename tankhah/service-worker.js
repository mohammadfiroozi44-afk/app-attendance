// Service worker for تنخواه‌یار (petty-cash app). Registered from tankhah/index.html, so its
// default scope is ./tankhah/ — it never sees or intercepts requests to the attendance app at
// the site root, and the attendance app's own service worker (scope ./) never sees requests
// here either. Cache name is also namespaced so the two apps never share or evict each other's
// cached shell.
var CACHE_NAME = 'tankhah-shell-v1';
var SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function(event){
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return cache.addAll(SHELL_FILES).catch(function(){ /* ignore individual failures */ });
    })
  );
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== CACHE_NAME; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event){
  var req = event.request;
  // Only handle same-origin GET requests for this app's own shell. Everything else (API calls
  // to Apps Script, fonts, etc.) goes straight to the network.
  if(req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req, {cache: 'no-store'}).then(function(res){
      var resClone = res.clone();
      caches.open(CACHE_NAME).then(function(cache){ cache.put(req, resClone); });
      return res;
    }).catch(function(){
      return caches.match(req).then(function(cached){ return cached || caches.match('./index.html'); });
    })
  );
});
