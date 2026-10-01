/* Gift Monitor PWA — офлайн-кэш оболочки, данные всегда из сети */
var CACHE = 'gm-v7-2';
var SHELL = ['./', './index.html', './logo.png', './icon-192.png', './manifest.webmanifest'];
self.addEventListener('install', function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(SHELL); }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener('fetch', function(e){
  var url = e.request.url;
  var isData = url.indexOf('status.json') >= 0 || url.indexOf('gifts.json') >= 0 ||
               url.indexOf('images.json') >= 0 || url.indexOf('history.json') >= 0;
  if (isData){
    /* данные: сеть первая, кэш — фолбэк для офлайна */
    e.respondWith(fetch(e.request).then(function(r){
      var cp = r.clone(); caches.open(CACHE).then(function(c){ c.put(e.request, cp); });
      return r;
    }).catch(function(){ return caches.match(e.request); }));
    return;
  }
  if (e.request.method !== 'GET') return;
  /* оболочка: кэш первый */
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(function(m){
    return m || fetch(e.request).then(function(r){
      var cp = r.clone(); caches.open(CACHE).then(function(c){ c.put(e.request, cp); });
      return r;
    });
  }));
});
