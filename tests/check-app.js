// Статична перевірка index.html: баланс sc-if/sc-for, синтаксис вбудованого
// JS-класу Component, відсутність конфліктних маркерів git. Ганяється в CI —
// ловить найчастіші поломки монолітного index.html ще до розгортання.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let fail = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (extra ? (' — ' + extra) : ''));
  if (!ok) fail = 1;
};

const oI = (html.match(/<sc-if\b/g) || []).length, cI = (html.match(/<\/sc-if>/g) || []).length;
check('sc-if збалансовано', oI === cI, oI + ' відкрито / ' + cI + ' закрито');
const oF = (html.match(/<sc-for\b/g) || []).length, cF = (html.match(/<\/sc-for>/g) || []).length;
check('sc-for збалансовано', oF === cF, oF + ' відкрито / ' + cF + ' закрито');
check('немає конфліктних маркерів git', !/^(<{7}|={7}|>{7})/m.test(html));

let found = 0;
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
let m;
while ((m = re.exec(html))) {
  const code = m[1];
  if (!/class\s+Component|renderVals|DCLogic/.test(code)) continue;
  found++;
  const tmp = path.join(os.tmpdir(), 'zbl-component-check.js');
  fs.writeFileSync(tmp, code);
  try { execFileSync(process.execPath, ['--check', tmp]); check('синтаксис Component (' + code.length + ' симв.)', true); }
  catch (e) { check('синтаксис Component', false, String(e.stderr || e.message)); }
}
check('скрипт Component знайдено', found === 1, 'знайдено ' + found);

// Версії застосунку і кешу оболонки мають рухатись РАЗОМ. Раніше тут була лише
// перевірка формату — тож index.html і sw.js спокійно розходились (2026.08.09
// проти arm-teplo-shell-v1), і оновлений застосунок міг лишитись зі старим
// кешем оболонки. Тепер звіряємо самі значення.
const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const swVer = (sw.match(/const APP_VERSION = '([\d.]+)'/) || [])[1];
const appVer = (html.match(/APP_VERSION\(\)\{ return '([\d.]+)'/) || [])[1];
check('index.html має APP_VERSION', !!appVer, appVer || 'не знайдено');
check('sw.js має APP_VERSION', !!swVer, swVer || 'не знайдено');
check('версії index.html і sw.js збігаються', !!appVer && appVer === swVer,
  'index.html ' + (appVer || '—') + ' / sw.js ' + (swVer || '—'));
check('ім\'я кешу SW похідне від версії', /const CACHE = 'arm-teplo-shell-' \+ APP_VERSION/.test(sw));

process.exit(fail);
