#!/usr/bin/env node
/*
 * АРМ Теплооблік — власний сервер бригадного збору (Фаза B).
 * Роздає сам додаток (index.html, support.js, vendor/) і надає простий API
 * синхронізації. Без зовнішніх залежностей — лише вбудовані модулі Node.
 *
 * Запуск:   node server.js           (порт 8083 за замовчуванням)
 *           PORT=9000 node server.js
 *
 * Дані зберігаються у файлі  arm-data/db.json  поряд із сервером.
 * (Тека arm-data/ у .gitignore — реальна база з персональними даними НЕ
 *  потрапляє в репозиторій.)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = parseInt(process.env.PORT || '8083', 10);
const DATA_DIR = path.join(ROOT, 'arm-data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos'); // фото винесені з db.json в окремі файли
const crypto = require('crypto');
const MAX_BODY = 64 * 1024 * 1024; // 64 МБ (показання з фото)

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json',
  '.webmanifest': 'application/manifest+json' };

// ---------- сховище ----------
function emptyDb(){ return { houses: [], boilers: [], readings: [], assignments: {}, assignmentsAt: {}, contacts: {}, routes: {}, closedAt: 0, periodKey: '', periodAt: 0, deletes: {}, swaps: {}, baseSig: '', savedAt: 0 }; }
// Розподіл зводиться по КЛЮЧАХ із мітками часу (як contacts/routes), а не цілою
// мапою — інакше два старших/адміни затирають правки одне одного (розподіл «блимає»).
// Міграція: наявним призначенням без мітки даємо базову «1» (живуть, але програють
// будь-якій свіжій правці). Порожній виконавець у assignments — тумбстоун.
function ensureAsgStamps(db){
  if (!db.assignmentsAt || typeof db.assignmentsAt !== 'object') db.assignmentsAt = {};
  for (const k in (db.assignments || {})) if (!db.assignmentsAt[k]) db.assignmentsAt[k] = 1;
}
function mergeAssignments(db, incAssign, incAt){
  ensureAsgStamps(db);
  if (!incAt || typeof incAt !== 'object') return;   // без міток (старий клієнт) — не чіпаємо, щоб не затер
  incAssign = incAssign || {};
  for (const k in incAt) {
    const iAt = Number(incAt[k]) || 0;
    if (iAt >= (Number(db.assignmentsAt[k]) || 0)) {
      const w = incAssign[k] || '';
      if (w) db.assignments[k] = w; else delete db.assignments[k];
      db.assignmentsAt[k] = iAt;
    }
  }
}
// Спільні мапи бригади «будинок → запис із міткою часу»: contacts (контактна
// особа; одна адреса — один контакт для ХВ і ГВ) та routes (домовленості про
// день/час). Будь-хто виправляє в полі — решта бачать після синхронізації.
// Правила зведення: новіший at перемагає (паралельні правки не затирають одна
// одну); «порожній» запис — це ТУМБСТОУН видалення, він ЗБЕРІГАЄТЬСЯ і теж
// розповсюджується (якщо запис просто стерти, інші пристрої повернуть його назад).
function mergeStampedMap(target, incoming, fields){
  const out = target || {};
  if (!incoming || typeof incoming !== 'object') return out;
  for (const k in incoming) {
    if (!Object.prototype.hasOwnProperty.call(incoming, k)) continue;
    const inc = incoming[k]; if (!inc || typeof inc !== 'object') continue;
    const ex = out[k];
    if (!ex || (Number(inc.at) || 0) >= (Number(ex.at) || 0)) {
      const rec = { at: Number(inc.at) || Date.now() };
      fields.forEach(f => { rec[f] = String(inc[f] == null ? '' : inc[f]); });
      out[k] = rec;
    }
  }
  return out;
}
function mergeContacts(db, incoming){ db.contacts = mergeStampedMap(db.contacts, incoming, ['name', 'phone']); }
function mergeRoutes(db, incoming){ db.routes = mergeStampedMap(db.routes, incoming, ['mode', 'date', 'time', 'note']); }
function loadDb(){
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return emptyDb(); }
}
// Щоденна резервна копія db.json (перша зміна за день робить знімок ПОПЕРЕДНЬОГО
// стану). Захищає історію показань від збою диска чи помилкового POST. Тримаємо
// 30 днів, старші чистяться самі. Тека: arm-data/backup/db-РРРР-ММ-ДД.json
// ---------- тека даних: створення + самозахист від прямого доступу ----------
// Node сам блокує /arm-data/ (див. serveStatic), але ті самі файли часто лежать
// під Apache (api.php). Кореневий .htaccess закриває теку лише за наявності
// mod_rewrite / mod_alias, тож кладемо ЩЕ ОДИН .htaccess у саму теку: правило
// «Require all denied» діє через mod_authz_core, який в Apache 2.4 є завжди.
// Інакше повна база з персональними даними (зокрема бекапи arm-data/backup/
// db-РРРР-ММ-ДД.json) качається за прямим URL.
const DATA_HTACCESS = [
  '# Тека даних АРМ Теплооблік: db.json, users.json, config.json (ключ API),',
  '# бекапи та фото. Створюється сервером автоматично — не редагуйте.',
  '# Прямий доступ через веб заборонено: дані віддаються ЛИШЕ через api.php',
  '# (з ключем бригади) або server.js.',
  '<IfModule mod_authz_core.c>',   // Apache 2.4
  '  Require all denied',
  '</IfModule>',
  '<IfModule !mod_authz_core.c>',  // Apache 2.2
  '  Order allow,deny',
  '  Deny from all',
  '</IfModule>',
  ''
].join('\n');
function ensureDataDir(){
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const f = path.join(DATA_DIR, '.htaccess');
  // best-effort і самолікування: якщо теку створили руками (як радить README),
  // захист доїде з першим же записом
  try { if (!fs.existsSync(f)) fs.writeFileSync(f, DATA_HTACCESS); } catch (e) {}
}
function backupDb(){
  try {
    if (!fs.existsSync(DB_FILE)) return;
    const dir = path.join(DATA_DIR, 'backup');
    ensureDataDir();
    fs.mkdirSync(dir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, 'db-' + today + '.json');
    if (fs.existsSync(file)) return;                       // сьогоднішня вже є
    fs.copyFileSync(DB_FILE, file);
    const keep = Date.now() - 30 * 24 * 3600 * 1000;
    fs.readdirSync(dir).forEach(f => {
      const m = f.match(/^db-(\d{4}-\d{2}-\d{2})\.json$/);
      if (m && new Date(m[1] + 'T00:00:00Z').getTime() < keep) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} }
    });
  } catch (e) { /* бекап — best-effort, роботу не блокує */ }
}
function saveDb(db){
  ensureDataDir();
  backupDb();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE); // атомарна заміна
}
function loadUsers(){ try { const j = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); return Array.isArray(j.users) ? j.users : []; } catch (e) { return []; } }
function saveUsers(users){
  ensureDataDir();
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, users: users }, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}

// ---------- фото: винесення data:URL у файли (щоб db.json не роздувався) ----------
function storePhoto(dataUrl){
  if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:') !== 0) return dataUrl; // вже посилання
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return dataUrl;
  let bin;
  try { bin = Buffer.from(dataUrl.slice(comma + 1), 'base64'); } catch (e) { return dataUrl; }
  if (!bin || !bin.length) return dataUrl;
  const id = 'p_' + crypto.createHash('sha1').update(bin).digest('hex');
  ensureDataDir();
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  const file = path.join(PHOTOS_DIR, id + '.jpg');
  if (!fs.existsSync(file)) fs.writeFileSync(file, bin);
  return 'srv:' + id;
}
function externalizePhotos(rec){
  if (!Array.isArray(rec.photos)) return;
  rec.photos = rec.photos.map(storePhoto);
}

// ---------- OCR-контроль: розпізнавання показника з фото хмарною моделлю ----------
const https = require('https');
const OCR_PROMPT = 'На фото — дисплей лічильника теплової енергії. Розпізнай головне числове показання (наростаюче значення на табло). Поверни ЛИШЕ це число: цифри, десятковий роздільник — крапка, без пробілів, одиниць та будь-якого іншого тексту. Якщо число не читається — поверни одне слово: null';
function ocrConfig(){
  let key = process.env.ARM_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || '';
  let model = process.env.ARM_OCR_MODEL || '';
  let base = process.env.ARM_ANTHROPIC_URL || '';
  try {
    const c = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'));
    if (!key && c.anthropicKey) key = c.anthropicKey;
    if (!model && c.ocrModel) model = c.ocrModel;
    if (!base && c.anthropicUrl) base = c.anthropicUrl;
  } catch (e) {}
  return { key, model: model || 'claude-opus-4-8', base: (base || 'https://api.anthropic.com').replace(/\/+$/, '') };
}
// ---------- ключ бригади (захист API на публічному хостингу) ----------
// Сервер тепер дивиться в інтернет, тож «довіри локальної мережі» замало:
// без захисту будь-хто міг скачати користувачів (і за секунди підібрати
// 4-значні PIN), витягти адреси/телефони з бази або залити фейкові показання.
// Ключ генерується один раз у arm-data/config.json ("brigadeKey") — старший
// вводить його на кожному телефоні (розділ «Виконавець»). Клієнт шле його
// заголовком X-Brigade-Key. Ключ 128-бітний — перебір неможливий, тож
// додаткові rate-limit'и не потрібні.
// Без ключа лишаються: /api/ping (перевірка живості) і /api/photo/<sha1>
// (адреса фото сама є 160-бітним секретом-перепусткою).
let _brigadeKey = null;
function brigadeKey(){
  if (_brigadeKey) return _brigadeKey;
  const cfgFile = path.join(DATA_DIR, 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) || {}; } catch (e) {}
  if (!cfg.brigadeKey) {
    cfg.brigadeKey = crypto.randomBytes(16).toString('hex');
    try {
      ensureDataDir();
      fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
      console.log('Згенеровано ключ бригади (введіть його на пристроях у «Виконавець»): ' + cfg.brigadeKey);
    } catch (e) { console.error('Не вдалося зберегти ключ бригади: ' + e.message); }
  }
  _brigadeKey = String(cfg.brigadeKey);
  return _brigadeKey;
}
function keyOk(req){
  return String(req.headers['x-brigade-key'] || '') === brigadeKey();
}

function ocrParseNumber(t){
  const m = String(t == null ? "" : t).match(/-?\d[\d \u00a0]*(?:[.,]\d+)?/);
  if (!m) return null;
  const v = parseFloat(m[0].replace(/[ \u00a0]/g, '').replace(',', '.'));
  return isNaN(v) ? null : v;
}
function anthropicCall(cfg, b64){
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model: cfg.model, max_tokens: 64, messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
      { type: 'text', text: OCR_PROMPT } ] }] });
    let u; try { u = new URL(cfg.base + '/v1/messages'); } catch(e){ return reject(new Error('некоректний ARM_ANTHROPIC_URL')); }
    const lib = u.protocol === 'http:' ? http : https;
    const rq = lib.request(u, { method: 'POST', headers: { 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01',
      'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ code: r.statusCode, body: d }));
    });
    rq.on('error', reject); rq.setTimeout(45000, () => rq.destroy(new Error('таймаут запиту до моделі')));
    rq.write(payload); rq.end();
  });
}

// ---------- зведення показань (дзеркалить клієнтський _mergeReadings) ----------
// нормалізація ключа має ТОЧНО збігатися з клієнтським _normAddr (та api.php),
// інакше ключ показання (тумбстоуна) на сервері не збіжиться з клієнтським і
// видалення не рознесеться. Клієнт стискає внутрішні пробіли — робимо так само.
const norm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
// wt (тип води) у ключі — щоб ХВ і ГВ одного особового рахунку за одну дату не
// злипались в одне показання (інакше історія одного з приладів втрачається).
// № лічильника — ОБОВ'ЯЗКОВА частина ключа: у будинку буває два прилади з
// ОДНАКОВИМ особовим і типом води; без нього друге показання затирало перше.
function keyOf(r){ return legacyKeyOf(r) + '|' + norm(r.meterNo); }
function legacyKeyOf(r){ return norm(r.account) + '|' + (r.date || '') + '|' + (r.wt || '') + '|' + (r.isControl ? 'k' : ''); }
function mergeReadings(db, incoming){
  const now = Date.now();
  const index = {}, legacyIndex = {};
  db.readings.forEach(r => { index[keyOf(r)] = r; const lk = legacyKeyOf(r); if (!legacyIndex[lk]) legacyIndex[lk] = r; });
  let added = 0, updated = 0, conflicts = 0, skipped = 0;
  (incoming || []).forEach(inc => {
    if (!inc || !inc.account) { skipped++; return; }
    const rec = Object.assign({}, inc); delete rec.houseId; delete rec.srvAt; // srvAt/houseId — серверні/локальні
    rec.synced = true;
    externalizePhotos(rec); // base64 → файли, у db.json лише посилання
    const k = keyOf(rec);
    // запис, збережений ДО появи № у ключі, підхоплюємо за старим ключем і
    // «всиновлюємо» (доповнюємо номером) — інакше вийшов би дубль тієї самої дати
    let ex = index[k];
    if (!ex && rec.meterNo) {
      const cand = legacyIndex[legacyKeyOf(rec)];
      if (cand && !cand.meterNo) ex = cand;
    }
    if (!ex) { rec.srvAt = now; db.readings.push(rec); index[k] = rec; added++; }
    else {
      const differ = ex.cur !== rec.cur || ex.prev !== rec.prev;
      if ((rec.at || 0) > (ex.at || 0)) { Object.keys(rec).forEach(kk => { ex[kk] = rec[kk]; }); ex.srvAt = now; updated++; if (differ) conflicts++; }
      else if (differ) conflicts++;
    }
  });
  return { added, updated, conflicts, skipped };
}
function maxSrvAt(db){ let m = 0; db.readings.forEach(r => { if ((r.srvAt || 0) > m) m = r.srvAt; }); return m; }

// ---------- HTTP ----------
function sendJson(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req){
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('занадто великий запит')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('некоректний JSON')); } });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url){
  const p = url.pathname;
  // GET /api/ping — перевірка наявності сервера (єдиний маршрут без ключа,
  // фото — окремо нижче: їх адреса сама є секретом)
  if (p === '/api/ping' && req.method === 'GET') return sendJson(res, 200, { ok: true, ts: Date.now() });
  if (!keyOk(req) && !(p.indexOf('/api/photo/') === 0 && req.method === 'GET'))
    return sendJson(res, 403, { error: 'потрібен ключ бригади', needKey: true });

  // GET /api/users — спільний список користувачів (клієнт перевіряє PIN локально,
  // тож вхід працює й офлайн з кешованого списку)
  if (p === '/api/users' && req.method === 'GET') return sendJson(res, 200, { users: loadUsers() });
  // POST /api/users — оновити список (адмін керує; довіра на рівні локальної мережі).
  // Захист від випадкового стирання: не приймаємо порожній список, якщо був непорожній.
  if (p === '/api/users' && req.method === 'POST') {
    const body = await readBody(req);
    const incoming = Array.isArray(body.users) ? body.users : null;
    if (!incoming) return sendJson(res, 400, { error: 'очікується { users: [...] }' });
    if (incoming.length === 0 && loadUsers().length > 0) return sendJson(res, 409, { error: 'відмова: спроба стерти всіх користувачів' });
    saveUsers(incoming);
    return sendJson(res, 200, { ok: true, count: incoming.length });
  }

  // GET /api/photo/<id> — віддати винесене фото
  if (p.indexOf('/api/photo/') === 0 && req.method === 'GET') {
    const id = p.slice('/api/photo/'.length);
    if (!/^p_[a-f0-9]{40}$/.test(id)) return sendJson(res, 400, { error: 'некоректний id' });
    const file = path.join(PHOTOS_DIR, id + '.jpg');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end('404'); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' });
      fs.createReadStream(file).pipe(res);
    });
    return;
  }

  // GET /api/ocr — чи налаштоване розпізнавання
  if (p === '/api/ocr' && req.method === 'GET') { const c = ocrConfig(); return sendJson(res, 200, { configured: !!c.key, model: c.model }); }
  // POST /api/ocr — розпізнати показник з фото (для звірки старшим)
  if (p === '/api/ocr' && req.method === 'POST') {
    const cfg = ocrConfig();
    if (!cfg.key) return sendJson(res, 501, { error: 'OCR не налаштовано: додайте ключ у arm-data/config.json ({"anthropicKey":"sk-..."})' });
    const body = await readBody(req);
    let b64 = null;
    if (body.dataUrl && String(body.dataUrl).indexOf('data:') === 0) { const c = String(body.dataUrl).indexOf(','); b64 = c === -1 ? null : String(body.dataUrl).slice(c + 1); }
    else if (body.id) { const id = String(body.id).replace(/^srv:/, ''); if (!/^p_[a-f0-9]{40}$/.test(id)) return sendJson(res, 400, { error: 'некоректний id фото' });
      const f = path.join(PHOTOS_DIR, id + '.jpg'); if (!fs.existsSync(f)) return sendJson(res, 404, { error: 'фото не знайдено на сервері' }); b64 = fs.readFileSync(f).toString('base64'); }
    if (!b64) return sendJson(res, 400, { error: 'немає фото для розпізнавання' });
    try {
      const { code, body: raw } = await anthropicCall(cfg, b64);
      let j = {}; try { j = JSON.parse(raw); } catch (e) {}
      if (code !== 200) return sendJson(res, 502, { error: 'модель: ' + ((j.error && j.error.message) || ('HTTP ' + code)) });
      let text = ''; (j.content || []).forEach(b => { if (b.type === 'text') text += b.text; });
      return sendJson(res, 200, { value: ocrParseNumber(text), raw: text.trim(), model: cfg.model });
    } catch (err) { return sendJson(res, 502, { error: 'запит до моделі не вдався: ' + (err && err.message || err) }); }
  }

  // GET /api/base — довідник для завантаження робітником (без показань)
  if (p === '/api/base' && req.method === 'GET') {
    const db = loadDb();
    ensureAsgStamps(db);
    return sendJson(res, 200, { hasBase: db.houses.length > 0, houses: db.houses, boilers: db.boilers,
      assignments: db.assignments, assignmentsAt: db.assignmentsAt || {}, contacts: db.contacts || {}, routes: db.routes || {}, baseSig: db.baseSig, savedAt: db.savedAt });
  }
  // POST /api/base — старший публікує довідник (показання й розподіл зберігаються)
  if (p === '/api/base' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.houses || !body.houses.length) return sendJson(res, 400, { error: 'порожня база' });
    const db = loadDb();
    db.houses = body.houses; db.boilers = body.boilers || []; db.baseSig = body.baseSig || '';
    // базові (архівні/імпортовані) показання — щоб робітник, який завантажить
    // базу, одразу бачив попередню історію (ідемпотентно, без дублювання)
    let baseAdded = 0;
    if (Array.isArray(body.readings) && body.readings.length) baseAdded = mergeReadings(db, body.readings).added;
    mergeContacts(db, body.contacts);
    mergeRoutes(db, body.routes);
    db.savedAt = Date.now();
    saveDb(db);
    return sendJson(res, 200, { ok: true, houses: db.houses.length, readings: db.readings.length, baseAdded, contacts: db.contacts || {}, routes: db.routes || {} });
  }
  // POST /api/sync — push черги + опційно розподіл; повертає ЛИШЕ показання,
  // змінені після body.since (інкрементально — щоб автосинхронізація не тягала
  // всі фото щоразу), а також розподіл.
  if (p === '/api/sync' && req.method === 'POST') {
    const body = await readBody(req);
    const db = loadDb();
    const warnBase = body.baseSig && db.baseSig && body.baseSig !== db.baseSig;
    const stats = mergeReadings(db, body.readings || []);
    mergeAssignments(db, body.assignments, body.assignmentsAt);
    // «закриття місяця» — бригадна мітка часу; перемагає новіша
    if (body.closedAt) db.closedAt = Math.max(Number(db.closedAt) || 0, Number(body.closedAt) || 0);
    // відкритий звітний період — бригадний; перемагає новіша мітка
    if (Number(body.periodAt) > (Number(db.periodAt) || 0) && /^\d{4}-\d{2}$/.test(String(body.periodKey || ''))) {
      db.periodKey = String(body.periodKey); db.periodAt = Number(body.periodAt);
    }
    // ТУМБСТОУНИ видалення: злити мітки (новіша перемагає) і прибрати показання
    if (!db.deletes || typeof db.deletes !== 'object') db.deletes = {};
    if (body.deletes && typeof body.deletes === 'object') {
      Object.keys(body.deletes).forEach(k => { const at = Number(body.deletes[k]) || 0; if (at > (Number(db.deletes[k]) || 0)) db.deletes[k] = at; });
    }
    if (Object.keys(db.deletes).length) {
      db.readings = db.readings.filter(r => { const at = Number(db.deletes[keyOf(r)]) || 0; return !(at && at >= (r.at || r.srvAt || 0)); });
    }
    // заміни приладів — бригадні; на кожен ключ перемагає новіша мітка
    if (!db.swaps || typeof db.swaps !== 'object') db.swaps = {};
    if (body.swaps && typeof body.swaps === 'object') {
      for (const k in body.swaps) {
        const inc = body.swaps[k]; if (!inc || typeof inc !== 'object') continue;
        const ex = db.swaps[k];
        if (!ex || (Number(inc.at) || 0) > (Number(ex.at) || 0)) db.swaps[k] = inc;
      }
    }
    mergeContacts(db, body.contacts);
    mergeRoutes(db, body.routes);
    db.savedAt = Date.now();
    saveDb(db);
    const since = Number(body.since) || 0;
    const out = since > 0 ? db.readings.filter(r => (r.srvAt || 0) > since) : db.readings;
    // keys — ПОВНИЙ набір ключів усіх показань на сервері (сервер = єдине джерело
    // правди). Клієнт звіряє свої польові показання: чого тут нема (видалили
    // будь-де) — прибирає й у себе. Легкий (лише ключі), тож іде щоразу навіть при
    // інкрементальному since; так видалення «зникає в усіх» без крихких тумбстоунів.
    return sendJson(res, 200, { ok: true, warnBase: !!warnBase, stats,
      readings: out, keys: db.readings.map(keyOf), maxSrvAt: maxSrvAt(db), assignments: db.assignments, assignmentsAt: db.assignmentsAt || {}, contacts: db.contacts || {}, routes: db.routes || {}, baseSig: db.baseSig,
      closedAt: db.closedAt || 0, periodKey: db.periodKey || '', periodAt: db.periodAt || 0, swaps: db.swaps || {},
      deletes: db.deletes || {}, hasBase: db.houses.length > 0 });
  }
  return sendJson(res, 404, { error: 'невідомий маршрут' });
}

function serveStatic(req, res, url){
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // тека даних (db.json, users.json, config.json з ключем API, фото з
  // персональними даними) НЕ віддається напряму — лише через /api
  if (/^\/+arm-data(\/|$)/.test(rel)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('403'); }
  // захист від виходу за межі теки
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('403'); }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  // Застосунок і API живуть на одному походженні — CORS-заголовків свідомо НЕМАЄ
  // (раніше стояло Access-Control-Allow-Origin: *, що дозволяло чужим сайтам
  // звертатись до API з браузера відвідувача).
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(err => sendJson(res, 500, { error: String(err && err.message || err) }));
    return;
  }
  serveStatic(req, res, url);
});

// Запускаємось лише коли файл виконано напряму (node server.js). При require
// (юніт-тести merge-логіки в tests/) сервер не стартує і нічого не пише на диск.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log('АРМ Теплооблік — сервер запущено на http://0.0.0.0:' + PORT + '/');
    console.log('Дані: ' + DB_FILE);
    console.log('Ключ бригади: ' + brigadeKey());
  });
}
module.exports = { mergeReadings, mergeContacts, mergeRoutes, mergeStampedMap, mergeAssignments, ensureAsgStamps, keyOf, emptyDb };
