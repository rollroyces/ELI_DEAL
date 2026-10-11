/**
 * HK ELI Portfolio Manager — service worker.
 *
 * Strategy: stale-while-revalidate for the static app shell, network-first
 * for everything else (Yahoo Finance + Finnhub prices are NEVER cached —
 * stale prices are dangerous for an investment-tracker).
 *
 * To bump the cache version after a deploy, change CACHE_VERSION and the
 * activate handler will drop the old caches.
 *
 * @file sw.js
 */
'use strict';

var CACHE_VERSION = 'hk-eli-v1';
var SHELL_CACHE = CACHE_VERSION + '-shell';
var RUNTIME_CACHE = CACHE_VERSION + '-runtime';

var SHELL_FILES = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './tests.html',
  './manifest.webmanifest',
  './js/db.js',
  './js/storage.js',
  './js/yahoo-finance.js',
  './js/finnhub.js',
  './js/sectors.js',
  './js/payoff.js',
  './js/types.js',
  './assets/icon-192.svg',
  './assets/icon-512.svg'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return cache.addAll(SHELL_FILES).catch(function (err) {
        // Don't fail the install if some optional files are missing.
        console.warn('[sw] shell pre-cache failed:', err);
        return Promise.all(
          SHELL_FILES.map(function (f) { return cache.add(f).catch(function () {}); })
        );
      });
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k.indexOf(CACHE_VERSION) !== 0;
      }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  // Never cache financial data — always go to network.
  if (url.hostname.indexOf('yahoo.com') !== -1
      || url.hostname.indexOf('finnhub.io') !== -1
      || url.hostname.indexOf('jsdelivr.net') !== -1) {
    event.respondWith(fetch(req).catch(function () {
      return new Response(JSON.stringify({ error: 'offline' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } });
    }));
    return;
  }

  // Same-origin: stale-while-revalidate for the shell, network-first for everything else.
  if (url.origin === self.location.origin) {
    var isShell = SHELL_FILES.some(function (f) {
      var path = f.replace(/^\.\//, '/');
      return url.pathname === path || url.pathname === path + '/';
    });
    if (isShell) {
      event.respondWith(
        caches.match(req).then(function (cached) {
          var networkFetch = fetch(req).then(function (resp) {
            var copy = resp.clone();
            caches.open(SHELL_CACHE).then(function (c) { c.put(req, copy); });
            return resp;
          }).catch(function () { return cached; });
          return cached || networkFetch;
        })
      );
      return;
    }
    event.respondWith(
      fetch(req).catch(function () {
        return caches.match(req).then(function (cached) {
          return cached || new Response('Offline', { status: 503 });
        });
      })
    );
    return;
  }

  // Cross-origin (e.g. fonts, CDN libs): network-first with cache fallback.
  event.respondWith(
    fetch(req).then(function (resp) {
      if (resp && resp.status === 200) {
        var copy = resp.clone();
        caches.open(RUNTIME_CACHE).then(function (c) { c.put(req, copy); });
      }
      return resp;
    }).catch(function () {
      return caches.match(req);
    })
  );
});

self.addEventListener('message', function (event) {
  if (event.data === 'skipWaiting') self.skipWaiting();
});