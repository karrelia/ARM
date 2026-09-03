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
 */
'use strict';
// APP_VERSION мусить збігатися з Component.APP_VERSION в index.html: за нею
// застосунок помічає оновлення (_checkForUpdate), а ім'я кешу робимо похідним,
// щоб один bump версії і показував тост «є оновлення», і скидав старий кеш
// оболонки. Розбіжність ловить tests/check-app.js.
const APP_VERSION = '2026.09.03';
const CACHE = 'arm-teplo-shell-' + APP_VERSION;
// оболонка застосунку для офлайн-кешу
const CORE = [
  './', './index.html', './support.js',
  './vendor/react.production.min.js', './vendor/react-dom.production.min.js',
  './manifest.webmanifest', './favicon.ico',
  './icons/icon-192.png', './icons/icon-512.png',
  './icons/icon-maskable-512.png', './icons/apple-touch-icon.png',
  './icons/favicon.svg', './icons/favicon-32.png'
];
// важке й необов'язкове для першого екрана (імпорт/експорт) — best-effort
const EXTRA = ['./vendor/xlsx.full.min.js'];

self.addEventListener('install', (e) => {
  // Кешуємо кожен файл ОКРЕМО й НЕ валимо встановлення, якщо якийсь недоступний.
  // Раніше атомарний addAll(CORE) через один 404 валив увесь service worker —
  // він не активувався, лишався «на паузі», і Chrome пропонував лише «ярлик»
  // замість «Встановити застосунок». Головне тут — гарантовано активуватись.
  e.waitUntil((async () => {
    try {
      const c = await caches.open(CACHE);
      await Promise.allSettled([...CORE, ...EXTRA].map((u) => c.add(new Request(u, { cache: 'reload' }))));
    } catch (err) { /* навіть без кешу активуємось — щоб працювала встановлюваність */ }
    await self.skipWaiting();
  })());
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

// тап по нагадуванню про зняття — відкрити (або сфокусувати) застосунок
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow('./index.html');
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // POST тощо — напряму в мережу
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // сторонні хости — напряму
  if (isApi(url)) return;                                 // API — тільки мережа, без кешу
  // перевірка версії (?vprobe): застосунок тягне живий index.html повз кеш, щоб
  // прочитати APP_VERSION — віддаємо лише з мережі й НЕ кешуємо (інакше кеш би
  // роздувався окремим записом на кожну перевірку)
  if (url.searchParams.has('vprobe')) return;

  // навігація: мережа-перше, але з ТАЙМАУТОМ 3 с — у підвалі з «однією паличкою»
  // fetch не падає, а висить хвилинами; без таймаута робітник бачить білий екран,
  // хоча робоча копія лежить у кеші. Мережа встигла — беремо свіже (і оновлюємо
  // кеш у фоні); не встигла — миттєво віддаємо кешовану оболонку.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const net = fetch(req).then((r) => {
        const cp = r.clone(); caches.open(CACHE).then((c) => c.put('./index.html', cp));
        return r;
      });
      try {
        return await Promise.race([
          net,
          new Promise((_, rej) => setTimeout(() => rej(new Error('nav-timeout')), 3000))
        ]);
      } catch (err) {
        const m = await caches.match('./index.html') || await caches.match('./');
        // кеш порожній (найперший візит) — нічого не вдієш, чекаємо мережу
        return m || net;
      }
    })());
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
