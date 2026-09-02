// Юніт-тести merge-логіки сервера (node --test tests/).
// server.js при require НЕ стартує (guard на require.main) і нічого не пише на диск.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { mergeReadings, mergeContacts, mergeRoutes, mergeStampedMap, keyOf, emptyDb } = require('../server.js');

// ---------- показання ----------
test('mergeReadings: додає нові показання', () => {
  const db = emptyDb();
  const st = mergeReadings(db, [{ account: 'ГІРСЬКА12', date: '2026-06-30', wt: 'cold', cur: 100 }]);
  assert.equal(st.added, 1);
  assert.equal(db.readings.length, 1);
  assert.ok(db.readings[0].srvAt > 0);
});

test('mergeReadings: ідемпотентність — повторний пуш не дублює', () => {
  const db = emptyDb();
  const rec = { account: 'ГІРСЬКА12', date: '2026-06-30', wt: 'cold', cur: 100 };
  mergeReadings(db, [rec]);
  const st2 = mergeReadings(db, [{ ...rec }]);
  assert.equal(db.readings.length, 1, 'дубль не додано');
  assert.equal(st2.added, 0);
});

test('mergeReadings: ХВ і ГВ одного особового за одну дату НЕ злипаються', () => {
  const db = emptyDb();
  mergeReadings(db, [
    { account: 'КАРБАНА20', date: '2026-06-30', wt: 'cold', cur: 700 },
    { account: 'КАРБАНА20', date: '2026-06-30', wt: 'hot', cur: 50 }
  ]);
  assert.equal(db.readings.length, 2);
  assert.notEqual(keyOf(db.readings[0]), keyOf(db.readings[1]));
});

test('mergeReadings: запис без особового пропускається', () => {
  const db = emptyDb();
  const st = mergeReadings(db, [{ date: '2026-06-30', cur: 1 }]);
  assert.equal(st.skipped, 1);
  assert.equal(db.readings.length, 0);
});

// ---------- спільні мапи (контакти / маршрут) ----------
test('mergeContacts: новіший at перемагає', () => {
  const db = emptyDb();
  mergeContacts(db, { 'a:к20': { name: 'Стара', phone: '1', at: 100 } });
  mergeContacts(db, { 'a:к20': { name: 'Нова', phone: '2', at: 200 } });
  assert.equal(db.contacts['a:к20'].name, 'Нова');
});

test('mergeContacts: старіший at НЕ затирає новіший (паралельні правки)', () => {
  const db = emptyDb();
  mergeContacts(db, { 'a:к20': { name: 'Нова', phone: '2', at: 200 } });
  mergeContacts(db, { 'a:к20': { name: 'Спізніла', phone: '1', at: 100 } });
  assert.equal(db.contacts['a:к20'].name, 'Нова');
});

test('mergeContacts: тумбстоун (порожній запис) ЗБЕРІГАЄТЬСЯ і розповсюджується', () => {
  const db = emptyDb();
  mergeContacts(db, { 'a:к20': { name: 'Марія', phone: '+380501112233', at: 100 } });
  mergeContacts(db, { 'a:к20': { name: '', phone: '', at: 200 } });   // видалення
  assert.ok(db.contacts['a:к20'], 'тумбстоун лишився в мапі');
  assert.equal(db.contacts['a:к20'].name, '');
  assert.equal(db.contacts['a:к20'].at, 200);
});

test('mergeRoutes: домовленість зберігається з усіма полями', () => {
  const db = emptyDb();
  mergeRoutes(db, { 'a:к20': { mode: 'appt', date: '2026-07-20', time: '10:30', note: 'код 25', at: 1 } });
  const r = db.routes['a:к20'];
  assert.equal(r.mode, 'appt');
  assert.equal(r.date, '2026-07-20');
  assert.equal(r.time, '10:30');
  assert.equal(r.note, 'код 25');
});

test('mergeStampedMap: сміттєві значення не ламають мапу', () => {
  const out = mergeStampedMap({}, { a: null, b: 'text', c: { name: 'ок', at: 5 } }, ['name']);
  assert.deepEqual(Object.keys(out), ['c']);
  assert.equal(out.c.name, 'ок');
});
