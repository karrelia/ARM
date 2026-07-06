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
const MAX_BODY = 64 * 1024 * 1024; // 64 МБ (показання з фото)

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json' };

// ---------- сховище ----------
function emptyDb(){ return { houses: [], boilers: [], readings: [], assignments: {}, baseSig: '', savedAt: 0 }; }
function loadDb(){
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return emptyDb(); }
}
function saveDb(db){
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE); // атомарна заміна
}
function loadUsers(){ try { const j = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); return Array.isArray(j.users) ? j.users : []; } catch (e) { return []; } }
function saveUsers(users){
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, users: users }, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}

// ---------- зведення показань (дзеркалить клієнтський _mergeReadings) ----------
const norm = s => String(s == null ? '' : s).trim().toLowerCase();
function keyOf(r){ return norm(r.account) + '|' + (r.date || '') + '|' + (r.isControl ? 'k' : ''); }
function mergeReadings(db, incoming){
  const now = Date.now();
  const index = {};
  db.readings.forEach(r => { index[keyOf(r)] = r; });
  let added = 0, updated = 0, conflicts = 0, skipped = 0;
  (incoming || []).forEach(inc => {
    if (!inc || !inc.account) { skipped++; return; }
    const rec = Object.assign({}, inc); delete rec.houseId; delete rec.srvAt; // srvAt/houseId — серверні/локальні
    rec.synced = true;
    const k = keyOf(rec), ex = index[k];
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
  // GET /api/ping — перевірка наявності сервера
  if (p === '/api/ping' && req.method === 'GET') return sendJson(res, 200, { ok: true, ts: Date.now() });

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

  // GET /api/base — довідник для завантаження робітником (без показань)
  if (p === '/api/base' && req.method === 'GET') {
    const db = loadDb();
    return sendJson(res, 200, { hasBase: db.houses.length > 0, houses: db.houses, boilers: db.boilers,
      assignments: db.assignments, baseSig: db.baseSig, savedAt: db.savedAt });
  }
  // POST /api/base — старший публікує довідник (показання й розподіл зберігаються)
  if (p === '/api/base' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.houses || !body.houses.length) return sendJson(res, 400, { error: 'порожня база' });
    const db = loadDb();
    db.houses = body.houses; db.boilers = body.boilers || []; db.baseSig = body.baseSig || ''; db.savedAt = Date.now();
    saveDb(db);
    return sendJson(res, 200, { ok: true, houses: db.houses.length, readings: db.readings.length });
  }
  // POST /api/sync — push черги + опційно розподіл; повертає ЛИШЕ показання,
  // змінені після body.since (інкрементально — щоб автосинхронізація не тягала
  // всі фото щоразу), а також розподіл.
  if (p === '/api/sync' && req.method === 'POST') {
    const body = await readBody(req);
    const db = loadDb();
    const warnBase = body.baseSig && db.baseSig && body.baseSig !== db.baseSig;
    const stats = mergeReadings(db, body.readings || []);
    if (body.assignments && typeof body.assignments === 'object') db.assignments = body.assignments;
    db.savedAt = Date.now();
    saveDb(db);
    const since = Number(body.since) || 0;
    const out = since > 0 ? db.readings.filter(r => (r.srvAt || 0) > since) : db.readings;
    return sendJson(res, 200, { ok: true, warnBase: !!warnBase, stats,
      readings: out, maxSrvAt: maxSrvAt(db), assignments: db.assignments, baseSig: db.baseSig,
      hasBase: db.houses.length > 0 });
  }
  return sendJson(res, 404, { error: 'невідомий маршрут' });
}

function serveStatic(req, res, url){
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
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
  // однакове походження — CORS не потрібен; але дозволимо на випадок іншого порту
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(err => sendJson(res, 500, { error: String(err && err.message || err) }));
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log('АРМ Теплооблік — сервер запущено на http://0.0.0.0:' + PORT + '/');
  console.log('Дані: ' + DB_FILE);
});
