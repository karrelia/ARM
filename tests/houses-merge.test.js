// Юніт-тести зведення ДОВІДНИКА прилад за приладом (автопублікація, server.js).
// Правила мають збігатися з api.php (merge_houses) і клієнтським _mergeBaseHouses.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { mergeHouses, mergeHouseDels, applyHouseDels, emptyDb } = require('../server.js');

const H = (o) => Object.assign({ account: 'П1', meterNo: '100', address: 'вул.Тестова, 1' }, o);

test('новіша правка перемагає, старша — ні', () => {
  const db = emptyDb();
  db.houses = [H({ id: 1, act: '5', upAt: 200 })];
  mergeHouses(db, [H({ id: 7, act: '9', upAt: 100 })]);          // старша — ігнор
  assert.equal(db.houses[0].act, '5');
  mergeHouses(db, [H({ id: 7, act: '8', upAt: 300 })]);          // новіша — бере, id серверний
  assert.equal(db.houses[0].act, '8');
  assert.equal(db.houses[0].id, 1);
  assert.equal(db.houses.length, 1);
});

test('новий прилад додається; id, що зайнятий іншим приладом, — новий', () => {
  const db = emptyDb();
  db.houses = [H({ id: 1 }), H({ id: 2, meterNo: '200' })];
  const st = mergeHouses(db, [H({ id: 2, meterNo: '300', upAt: 50 })]);
  assert.equal(st.added, 1);
  assert.equal(db.houses.length, 3);
  assert.equal(db.houses[2].id, 3);
  assert.equal(db.houses[1].meterNo, '200', 'інший прилад з тим самим id не перезаписано');
});

test('після заміни приладу — зіставлення за № до заміни', () => {
  const db = emptyDb();
  db.houses = [H({ id: 1, meterNo: '100' }), H({ id: 2, meterNo: '101' })];
  mergeHouses(db, [H({ id: 1, meterNo: '900', upAt: 10, meterSwaps: [{ oldNo: '100', newNo: '900' }] })]);
  assert.equal(db.houses.length, 2);
  assert.equal(db.houses[0].meterNo, '900');
  assert.equal(db.houses[1].meterNo, '101');
});

test('прилади, яких немає в пакеті, лишаються', () => {
  const db = emptyDb();
  db.houses = [H({ id: 1 }), H({ id: 2, meterNo: '200' })];
  mergeHouses(db, [H({ id: 1, act: '3', upAt: 5 })]);
  assert.equal(db.houses.length, 2);
});

test('№ лічильника змінили в картці — зіставлення за попереднім ключем, без дубля', () => {
  const db = emptyDb();
  db.houses = [H({ id: 1, account: 'ІГНАТЕНКА6', meterNo: '' }), H({ id: 2, meterNo: '200' })];
  mergeHouses(db, [H({ id: 1, account: 'ІГНАТЕНКА6', meterNo: '6666666', act: '331', upAt: 9, prevKeys: ['ігнатенка6|'] })]);
  assert.equal(db.houses.length, 2);
  assert.equal(db.houses[0].meterNo, '6666666');
  assert.equal(db.houses[0].act, '331');
});

test('видалений прилад прибирається й не повертається злиттям; правлений пізніше — лишається', () => {
  const db = emptyDb();
  db.houses = [H({ id: 1, meterNo: '' , upAt: 10 }), H({ id: 2, meterNo: '6666666', upAt: 10 })];
  mergeHouseDels(db, { 'п1|': 100 });
  assert.equal(applyHouseDels(db), 1);
  assert.deepEqual(db.houses.map(h => h.meterNo), ['6666666']);
  mergeHouses(db, [H({ id: 9, meterNo: '', upAt: 50 })]);        // старий пристрій надсилає дубль
  assert.equal(db.houses.length, 1, 'видалений не повернувся');
  mergeHouses(db, [H({ id: 9, meterNo: '', upAt: 200 })]);       // свідомо створений пізніше
  assert.equal(db.houses.length, 2);
});
