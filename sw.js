/*
 * АРМ Теплооблік — service worker.
 * Кешує оболонку застосунку, щоб він відкривався офлайн (лічильники в підвалах
 * без покриття) і встановлювався на домашній екран як застосунок.
 *
 * Стратегії:
 *   • навігація (HTML)      — мережа-перше, відкат на кешований index.html
 *                             (онлайн — свіжий код, офлайн — робоча копія);
 *   • статика (JS/іконки)   — stale-while-revalidate (миттєво з кешу, оновлення у фоні);
 *   • /api/… та /api.php/…  — НЕ кешуються, лише мережа (дані завжди свіжі/чесні).
 *
 * Версію кешу міняти при зміні набору оболонки, щоб старі файли підчистились.
 */
'use strict';
const CACHE = 'arm-shell-v1';
// критична оболонка — кешується атомарно під час install
const CORE = [
  './', './index.html', './support.js',
  './vendor/react.production.min.js', './vendor/react-dom.production.min.js',
  './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png',
  './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'
];
// важке й необов'язкове для першого екрана (імпорт/експорт) — best-effort
const EXTRA = ['./vendor/xlsx.full.min.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(CORE).then(() => { c.addAll(EXTRA).catch(() => {}); }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isApi(url) {
  return url.pathname.indexOf('/api/') !== -1 || url.pathname.indexOf('/api.php') !== -1;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // POST тощо — напряму в мережу
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // сторонні хости — напряму
  if (isApi(url)) return;                                 // API — тільки мережа, без кешу

  // навігація: мережа-перше з відкатом на кеш
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put('./index.html', cp)); return r; })
        .catch(() => caches.match('./index.html').then((m) => m || caches.match('./')))
    );
    return;
  }

  // статика: stale-while-revalidate
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((r) => {
        if (r && r.ok && r.type === 'basic') { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); }
        return r;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
