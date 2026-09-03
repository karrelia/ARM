// Рендер-тест застосунку в справжньому браузері (headless Chromium).
//
// Навіщо. index.html — моноліт: шаблон <x-dc> і клас Component лежать в одному
// файлі, а зв'язок між ними — рядковий ({{ ov.loadTxt }} шукає ключ loadTxt у
// renderVals). Перейменували ключ у шаблоні й забули в renderVals — рантайм
// НЕ падає: він малює порожнє місце й тихо пише в консоль
// «[dc-runtime] … never resolved — rendered as empty». Ані node --check, ані
// баланс sc-if такого не бачать, тож поломка їде на телефон робітника.
//
// Цей тест бутить застосунок із демо-даними, обходить усі вкладки на телефонній
// і ПК-верстці й падає, якщо: сталася JS-помилка, рантайм повідомив про
// невирішений плейсхолдер, у DOM є маркери помилок рантайму або сторінка
// взагалі не відрендерилась.
//
// Сервера навмисно НЕМАЄ (усі /api/… обриваються) — це штатний офлайн-режим,
// у якому застосунок і працює в підвалі.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8731;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

let fail = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (extra ? (' — ' + extra) : ''));
  if (!ok) fail = 1;
};

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  const msg = 'playwright недоступний (npm i --no-save playwright)';
  // У CI пропуск неприпустимий — інакше тест «зеленіє», нічого не перевіривши.
  if (process.env.CI) { check('рендер-тест запущено', false, msg); process.exit(1); }
  console.log('  --  рендер-тест пропущено: ' + msg);
  process.exit(0);
}

// Chromium, попередньо встановлений у образі, може не збігатися версією з
// playwright із npm — тоді шлях до бінарника задають через змінну середовища.
const EXE = process.env.ARM_CHROMIUM || undefined;

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      // сервера бригади немає: обриваємо з'єднання, щоб клієнт побачив
      // «офлайн», а не «сервер відповів помилкою»
      if (req.url.startsWith('/api')) return req.socket.destroy();
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, rel === '/' ? '/index.html' : rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404); return res.end('404');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

// Маркери, якими рантайм позначає власні поломки просто в DOM.
const ERR_SELECTORS = ['.sc-logic-error', '.sc-has-error', '.sc-placeholder-error',
  '.sc-interp.sc-unresolved', '.sc-interp.sc-missing'];

async function domErrors(page) {
  return page.evaluate((sels) => {
    const out = [];
    sels.forEach(s => document.querySelectorAll(s).forEach(el => {
      out.push(s + ': ' + (el.textContent || '').trim().slice(0, 120));
    }));
    return out;
  }, ERR_SELECTORS);
}

(async () => {
  const srv = await serve();
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  // короткий таймаут: якщо застосунок зламано, тест має падати за секунди
  // з причиною, а не висіти пів хвилини на пошуку кнопки, якої вже немає
  ctx.setDefaultTimeout(10000);
  const page = await ctx.newPage();

  // Тест герметичний: усе, що не з нашого сервера (шрифти Google), глушимо.
  // Застосунок і так має працювати без інтернету — а CI не повинен залежати
  // від доступності сторонніх хостів (інакше DOMContentLoaded чекає на таймаут
  // мережі й тест «падає» через чужі проблеми).
  await page.route('**/*', (route) => {
    const u = route.request().url();
    return u.startsWith('http://127.0.0.1:' + PORT) ? route.continue() : route.abort();
  });

  const jsErrors = [];        // винятки — застосунок зламано
  const holes = [];           // невирішені плейсхолдери шаблону
  page.on('pageerror', e => jsErrors.push(String(e.message || e)));
  page.on('console', m => {
    const t = m.text();
    // мережевий шум (немає сервера, немає Google Fonts) не цікавить —
    // ловимо лише скарги самого рантайму
    if (t.includes('[dc-runtime]')) holes.push(t);
  });

  const url = 'http://127.0.0.1:' + PORT + '/index.html';
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);

  // --- перший запуск: створюємо старшого (інакше решта UI прихована) ---
  const nameInput = page.locator('input[placeholder="напр. Петро Сеник"]');
  check('екран першого запуску показано', await nameInput.count() > 0);
  await nameInput.fill('Тест Тестенко');
  const pins = page.locator('input[type="password"], input[inputmode="numeric"]');
  for (let i = 0, n = await pins.count(); i < n; i++) await pins.nth(i).fill('1234');
  for (const t of ['Створити', 'Продовжити', 'Почати', 'Готово', 'Увійти']) {
    const btn = page.locator('button', { hasText: t }).first();
    if (await btn.count() && await btn.isVisible()) { await btn.click(); break; }
  }
  await page.waitForTimeout(900);

  // --- демо-дані: без них половина шаблону не рендериться взагалі ---
  const demo = page.locator('button', { hasText: 'Демо-дані' }).first();
  check('кнопка «Демо-дані» доступна', await demo.count() > 0);
  await demo.click();
  await page.waitForTimeout(1500);

  // Сторінка справді ожила (щоб порожній екран не проходив як «без помилок»).
  const body = await page.locator('body').innerText();
  const rendered = /Спожито ТЕ/i.test(body) && /Гкал/.test(body);
  check('огляд відрендерився', rendered, body.trim().slice(0, 80).replace(/\n/g, ' '));
  // Зламаний рендер робить усі подальші перевірки безглуздими (і призвів би до
  // низки таймаутів на пошуку кнопок) — доповідаємо причину й виходимо одразу.
  if (!rendered) {
    (await domErrors(page)).forEach(e => check('маркер помилки рантайму', false, e));
    jsErrors.slice(0, 3).forEach(e => check('JS-помилка', false, e));
    holes.slice(0, 5).forEach(e => check('невирішений плейсхолдер', false, e));
    await browser.close(); srv.close();
    process.exit(1);
  }

  // --- обхід вкладок на обох верстках ---
  async function walkTabs(label) {
    const tabs = page.locator('.tabBar button');
    const n = await tabs.count();
    check(label + ': вкладки на місці', n >= 5, n + ' шт.');
    for (let i = 0; i < n; i++) {
      const name = (await tabs.nth(i).innerText()).trim().replace(/\s+/g, ' ');
      await tabs.nth(i).click({ force: true });
      await page.waitForTimeout(700);
      const errs = await domErrors(page);
      check(label + ' · вкладка «' + name + '»', errs.length === 0, errs.join(' | '));
    }
  }
  await walkTabs('телефон');

  // деталь будинку — великий окремий шар шаблону
  await page.locator('.tabBar button', { hasText: 'Будинки' }).first().click({ force: true });
  await page.waitForTimeout(700);
  const house = page.locator('text=/вул\\./').first();
  if (await house.count()) {
    await house.click({ force: true });
    await page.waitForTimeout(900);
    const errs = await domErrors(page);
    check('телефон · картка будинку', errs.length === 0, errs.join(' | '));
  }

  // --- ПК-верстка: ліва рейка + вкладка «Акти», яких немає на телефоні ---
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await walkTabs('ПК');

  check('немає JS-помилок', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
  check('немає невирішених плейсхолдерів шаблону', holes.length === 0, holes.slice(0, 5).join(' | '));

  await browser.close();
  srv.close();
  process.exit(fail);
})().catch(err => {
  console.log(' FAIL рендер-тест впав: ' + (err && err.message || err));
  process.exit(1);
});
