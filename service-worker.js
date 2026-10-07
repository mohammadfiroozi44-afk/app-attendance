// Service worker — makes the app installable and keeps the last-loaded shell
// available offline. It does NOT cache API calls (attendance data always needs
// to be fresh/live), only the static app shell (HTML/CSS/JS/icons).

var CACHE_NAME = 'tardod-shell-v3';
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

// The page asks for this when the user hits «به‌روزرسانی اجباری»: throw away every
// cached shell file so the next load has to come from the network.
self.addEventListener('message', function(event){
  var data = event.data || {};
  if(data.type !== 'TARDOD_FLUSH_CACHE') return;
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){ return caches.delete(k); }));
    }).then(function(){
      if(event.source && event.source.postMessage) event.source.postMessage({type:'TARDOD_CACHE_FLUSHED'});
    })
  );
});

self.addEventListener('fetch', function(event){
  var req = event.request;
  // Only handle same-origin GET requests for the app shell. Everything else
  // (API POSTs to Apps Script, map tiles, fonts, etc.) goes straight to the network.
  if(req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  var url = new URL(req.url);
  // version.json is the staleness probe itself — if it ever came from the cache the
  // app could never notice a new upload, so it always goes straight to the network.
  if(/version\.json$/.test(url.pathname)) return;

  event.respondWith(
    fetch(req, {cache: 'no-store'}).then(function(res){
      // Don't cache one-off URLs (the cache-busting ?v=... probes) — they'd just
      // pile up under keys nothing ever reads again.
      if(!url.search){
        var resClone = res.clone();
        caches.open(CACHE_NAME).then(function(cache){ cache.put(req, resClone); });
      }
      return res;
    }).catch(function(){
      return caches.match(req, {ignoreSearch: true}).then(function(cached){ return cached || caches.match('./index.html'); });
    })
  );
});

// Ready for future push notifications (e.g. via Firebase Cloud Messaging) — safe no-ops
// until a push backend is actually wired up.
self.addEventListener('push', function(event){
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e){ data = { title: 'ثبت تردد', body: event.data ? event.data.text() : '' }; }
  var title = data.title || 'ثبت تردد سایت';
  var options = {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    dir: 'rtl',
    lang: 'fa'
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event){
  event.notification.close();
  event.waitUntil(
    clients.matchAll({type:'window'}).then(function(clientList){
      for(var i=0;i<clientList.length;i++){
        if('focus' in clientList[i]) return clientList[i].focus();
      }
      if(clients.openWindow) return clients.openWindow('./index.html');
    })
  );
});
