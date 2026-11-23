// Юніт-тести бригадного очищення попередніх періодів (server.js).
// Правила мають ТОЧНО збігатися з клієнтським _applyPurge та api.php.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { mergePurge, applyPurge, periodOf, emptyDb } = require('../server.js');

const rd = (o) => Object.assign({ account: 'П1', wt: 'kom', meterNo: '1', cur: 1 }, o);

test('periodOf: period, інакше місяць дати', () => {
  assert.equal(periodOf({ period: '2026-03', date: '2026-04-02' }), '2026-03');
  assert.equal(periodOf({ period: 'Березень', date: '2026-04-02' }), '2026-04');
  assert.equal(periodOf({ date: '' }), '');
});

test('applyPurge: прибирає старші періоди, створені до мітки', () => {
  const db = emptyDb();
  db.readings = [
    rd({ date: '2026-01-25', period: '2026-01' }),            // книга, без at — під очищення
    rd({ date: '2026-02-25', period: '2026-02', at: 50 }),    // польове до мітки — під очищення
    rd({ date: '2026-03-28', period: '2026-03', at: 50 }),    // поточний період — лишається
    rd({ date: '2026-02-10', period: '2026-02', at: 500 }),   // внесено ПІСЛЯ очищення — лишається
    rd({ date: '', isControl: true, at: 10 })                 // старе контрольне — під очищення
  ];
  mergePurge(db, { purgeBefore: '2026-03', purgeAt: 100 });
  assert.equal(applyPurge(db), 3);
  assert.deepEqual(db.readings.map(r => r.date), ['2026-03-28', '2026-02-10']);
});

test('mergePurge: новіша мітка перемагає, старіша ігнорується', () => {
  const db = emptyDb();
  mergePurge(db, { purgeBefore: '2026-03', purgeAt: 200 });
  mergePurge(db, { purgeBefore: '2025-01', purgeAt: 100 });
  assert.equal(db.purgeBefore, '2026-03');
  mergePurge(db, { purgeBefore: '', purgeAt: 300 });             // «Зняти» обмеження
  assert.equal(db.purgeBefore, '');
  db.readings = [rd({ date: '2020-01-01' })];
  assert.equal(applyPurge(db), 0, 'без обмеження нічого не видаляється');
});

test('mergePurge: сміття в ключі не приймається', () => {
  const db = emptyDb();
  mergePurge(db, { purgeBefore: 'Березень', purgeAt: 100 });
  assert.equal(db.purgeBefore, '');
  assert.equal(db.purgeAt, 0);
});
