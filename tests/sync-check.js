// Тест синхронізації між РІЗНИМИ ПРИСТРОЯМИ (node tests/sync-check.js).
//
// Піднімає справжній server.js на тимчасовій теці даних і два незалежні
// контексти браузера — «ПК старшого» і «телефон робітника» (окремі IndexedDB /
// localStorage, як на різних пристроях). Робітник частину часу працює ОФЛАЙН.
// Перевіряє, що до іншого пристрою доходять: база, показання (і офлайн-черга),
// заміна приладу, повірка та її скасування, очищення періодів, новий прилад і
// правки довідника.
//
// Потрібен Playwright (як і для render-check.js); без нього тест пропускається.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8790 + Math.floor(Math.random() * 100);
let fail = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (extra != null && extra !== '' ? (' — ' + extra) : ''));
  if (!ok) fail = 1;
};

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  const msg = 'playwright недоступний (npm i --no-save playwright)';
  if (process.env.CI) { check('тест синхронізації запущено', false, msg); process.exit(1); }
  console.log('  --  тест синхронізації пропущено: ' + msg);
  process.exit(0);
}
const EXE = process.env.ARM_CHROMIUM || undefined;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Екземпляр логіки застосунку (клас Component) — шукаємо через React-дерево:
// рантайм тримає його як .logic у компоненті-обгортці.
const GRAB = `(() => {
  if (window.__arm) return true;
  for (const el of document.querySelectorAll('*')) {
    const k = Object.keys(el).find(x => x.startsWith('__reactFiber'));
    if (!k) continue;
    let f = el[k];
    while (f) { if (f.stateNode && f.stateNode.logic && f.stateNode.logic.renderVals) { window.__arm = f.stateNode.logic; return true; } f = f.return; }
  }
  return false;
})()`;

async function device(browser, label) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  page.on('dialog', d => d.accept());                    // confirm() — «так»
  await page.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'domcontentloaded' });
  await wait(1200);
  await page.evaluate(GRAB);
  // зручний виклик методів/стану логіки
  const run = (fn, arg) => page.evaluate(([src, a]) => (new Function('a', 'arg', 'return (' + src + ')(a, arg)'))(window.__arm, a), [fn.toString(), arg]);
  return { ctx, page, run, errors, label };
}
// Дочекатися фонової синхронізації (заміна, повірка, збереження картки самі її
// запускають) і синхронізувати ще раз — інакше виклик під час «зайнято» мовчки
// пропускається, і інший пристрій синхронізувався б раніше, ніж зміна дійшла
async function syncNow(d) {
  await d.run(async (a) => { await a._waitCloudIdle(15000); await a.cloudSync(true); await a._waitCloudIdle(15000); });
  await wait(150);
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-sync-'));
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), ARM_DATA_DIR: dataDir }), stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = '';
  srv.stdout.on('data', b => { srvLog += b; }); srv.stderr.on('data', b => { srvLog += b; });
  for (let i = 0; i < 50 && !/http:\/\//.test(srvLog); i++) await wait(100);
  const key = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).brigadeKey;
  check('сервер бригади запущено (тимчасова тека даних)', !!key);

  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});
  const A = await device(browser, 'ПК старшого');
  const B = await device(browser, 'телефон робітника');
  const finish = async () => { await browser.close(); srv.kill(); try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {} };

  try {
    // ---------- 1. ключ бригади, старший, робітник ----------
    await A.run(async (a, k) => { a.setState({ keyInput: k }); await new Promise(r => setTimeout(r, 50)); a.saveBrigadeKey(); }, key);
    await wait(800);
    await A.run(async (a) => { a.setState({ foName: 'Старший Тест', foPin: '1111' }); await new Promise(r => setTimeout(r, 50)); await a.createFirstAdmin(); });
    await wait(500);
    await A.run(async (a) => { a.setState({ nuName: 'Робітник Тест', nuPin: '2222', nuLvl: 'worker' }); await new Promise(r => setTimeout(r, 50)); await a.addUser(); });
    await wait(500);
    check('старший увійшов, робітника додано', await A.run(a => a.state.authUser && a.state.users.length === 2));

    // ---------- 2. база з актів у старшого → публікація ----------
    await A.page.addScriptTag({ url: '/vendor/xlsx.full.min.js' });
    const xlsx = await A.page.evaluate(() => {
      const aoa = [
        ['№', 'Дата', 'Адреса', 'Споживач', 'Особовий рахунок', '№ лічильника', 'Ком. облік (№ у рамці)', 'Вид обліку',
          'Кількість теплової енергії по лічильнику', '', '', "Об'єм води по теплолічильнику, м3", '', 'Наробітка теплолічильника, дні/години', '', 'Простой теплолічильника, год.', ''],
        ['', '', '', '', '', '', '', '', 'Од. виміру', 'Попереднє', 'Теперішнє', 'Попереднє', 'Теперішнє', 'Попереднє', 'Теперішнє', 'Попереднє', 'Теперішнє'],
        [1, '27.03.2026', 'вул.Тестова, 1', 'Іваненко І.І., кв. 1', 'Т001', '10000001', 1, 'росп.', 'Гкал', 100, 110, 500, 520, 1000, 1700, 0, 0],
        [2, '27.03.2026', 'вул.Тестова, 1', 'Петренко П.П., кв. 2', 'Т002', '10000002', 2, 'росп.', 'МВт', 200, 205, 600, 610, 1000, 1700, 5, 5],
        [3, '27.03.2026', 'вул.Тестова, 3', 'ТОВ «Тест»', 'Т003', '10000003', 3, 'ком.', 'ГДж', 300, 330, 700, 760, 1000, 1700, 10, 12],
        [4, '28.03.2026', 'вул.Тестова, 5', 'Будинок Тестова 5', 'Т005', '10000005', 4, 'ком.', 'Гкал', 400, 450, 800, 900, 1000, 1700, 0, 0]
      ];
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(aoa), 'Акти');
      return Array.from(new Uint8Array(window.XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
    });
    await A.page.setInputFiles('#dbImportInput', { name: 'akty.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from(xlsx) });
    await wait(1200);
    await A.run(a => { a.setState({ actsClear: false }); });
    await wait(100);
    await A.run(a => a.confirmActsPlan());
    await wait(400);
    await A.run(async (a) => { await a.cloudPublishBase(); });
    await wait(300);
    await syncNow(A);
    check('старший: 4 прилади й 4 показання з актів', await A.run(a => a.db.houses.length === 4 && a.db.readings.length === 4),
      await A.run(a => a.db.houses.length + ' / ' + a.db.readings.length));

    // ---------- 3. робітник: ключ, вхід, база з сервера ----------
    await B.run(async (a, k) => { a.setState({ keyInput: k }); await new Promise(r => setTimeout(r, 50)); a.saveBrigadeKey(); }, key);
    await wait(900);
    await B.run(async (a) => { const u = a.state.users.find(x => x.name === 'Робітник Тест'); a.setState({ loginSel: u.id, loginPin: '2222' }); await new Promise(r => setTimeout(r, 50)); a.doLogin(); });
    await wait(300);
    check('робітник увійшов на своєму пристрої', await B.run(a => !!a.state.authUser && a.state.authUser.name === 'Робітник Тест'));
    await B.run(async (a) => { await a.cloudLoadBase(); });
    await wait(1500);
    await syncNow(B);
    check('робітник: база й показання з сервера', await B.run(a => a.db.houses.length === 4 && a.db.readings.length === 4),
      await B.run(a => a.db.houses.length + ' приладів / ' + a.db.readings.length + ' показань'));
    check('робітник: № акта з бази', await B.run(a => a.db.houses.find(h => h.meterNo === '10000003').act === '3'));

    // ---------- 4. показання робітника → старшому ----------
    const enter = (d, meterNo, cur) => d.run(async (a, x) => {
      const h = a.db.houses.find(q => q.meterNo === x.m);
      a.tapMeter(h); await new Promise(r => setTimeout(r, 150));
      a.setState({ eCur: String(x.c), eDate: new Date().toISOString().slice(0, 10) }); await new Promise(r => setTimeout(r, 100));
      a.saveReading(); await new Promise(r => setTimeout(r, 150));
      return a._lastReading(h.id).cur;
    }, { m: meterNo, c: cur });
    await enter(B, '10000003', 340);
    await syncNow(B); await syncNow(A);
    check('показання робітника дійшло до старшого', await A.run(a => { const h = a.db.houses.find(q => q.meterNo === '10000003'); const l = a._lastReading(h.id); return l && l.cur === 340 && l.by === 'Робітник Тест'; }));

    // ---------- 5. офлайн-черга робітника ----------
    await B.ctx.setOffline(true);
    await enter(B, '10000005', 470);
    await syncNow(B);
    check('офлайн: показання лишилось у черзі', await B.run(a => a._pendingCount() === 1), 'черга: ' + await B.run(a => a._pendingCount()));
    await B.ctx.setOffline(false);
    await syncNow(B); await syncNow(A);
    check('після появи мережі черга дійшла до старшого', await A.run(a => { const h = a.db.houses.find(q => q.meterNo === '10000005'); return a._lastReading(h.id).cur === 470; })
      && await B.run(a => a._pendingCount() === 0));

    // ---------- 6. заміна приладу старшим → робітнику ----------
    await A.run(async (a) => {
      const h = a.db.houses.find(q => q.meterNo === '10000001');
      a.openMeterSwap(h.id); await new Promise(r => setTimeout(r, 50));
      a.setState({ swapNewNo: '20000001', swapOldLast: '115', swapNewInit: '0', swapOldVoda: '530', swapNewVoda: '1', swapOldNar: '1800', swapNewNar: '2', swapOldProst: '0', swapNewProst: '0', swapNewUnit: 'МВт', swapNewPov: '2026-11-01' });
      await new Promise(r => setTimeout(r, 50)); a.saveMeterSwap();
    });
    await wait(300); await syncNow(A); await syncNow(B);
    const swB = await B.run(a => { const h = a.db.houses.find(q => q.account === 'Т001');
      return { no: h.meterNo, unit: h.unit, pov: h.obcPovirka, prevVoda: h.prevVoda, prev: a._prevEnergy(h.id),
        recs: a._houseReadings(h.id).filter(r => r.swapIn || r.swapOut).length }; });
    check('заміна: у робітника новий № і показники', swB.no === '20000001' && swB.prev === 0 && swB.prevVoda === 1 && swB.recs === 2, JSON.stringify(swB));
    check('заміна: одиниці й повірка нового — у робітника', swB.unit === 'МВт' && swB.pov === '2026-11-01', swB.unit + ' / ' + swB.pov);

    // ---------- 6а. застаріла картка ДО заміни (з іншого пристрою) не стає другим приладом ----------
    // на B — дубль, як у реальній ситуації: стара картка Т001/10000001 з показанням
    const swDupPrep = await B.run(async (a) => {
      const real = a.db.houses.find(q => q.account === 'Т001');
      const id = a.db.houses.reduce((m, h) => Math.max(m, h.id), 0) + 1;
      const stale = Object.assign({}, real, { id, meterNo: '10000001', meterSwaps: [], upAt: 1 });
      a.db.houses.push(stale);
      const r = a.db.readings.find(x => x.houseId === real.id && !x.isControl);
      if (r) r.houseId = id;                                   // історія «прилипла» до дубля
      a._persist();
      return { n: a.db.houses.filter(q => q.account === 'Т001').length, stale };
    });
    // старий пристрій публікує стару картку на сервер
    await A.run(async (a, st) => {
      await a._apiFetch('/base', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'merge', houses: [Object.assign({}, st, { upAt: 2 })], boilers: [] }) });
    }, swDupPrep.stale);
    for (let i = 0; i < 2; i++) { await syncNow(A); await syncNow(B); }
    await B.run(async (a) => { await a.cloudRefreshBase(); await a._waitCloudIdle(15000); });
    await A.run(async (a) => { await a.cloudRefreshBase(); await a._waitCloudIdle(15000); });
    const swDupB = await B.run(a => a.db.houses.filter(q => q.account === 'Т001').map(h => h.meterNo + ':' + a._houseReadings(h.id).length));
    const swDupA = await A.run(a => a.db.houses.filter(q => q.account === 'Т001').map(h => h.meterNo));
    check('дубль після заміни був на пристрої', swDupPrep.n === 2, String(swDupPrep.n));
    check('після заміни — одна картка (новий №) і вся історія на ній', swDupB.length === 1 && /^20000001:\d+$/.test(swDupB[0]) && Number(swDupB[0].split(':')[1]) >= 3, JSON.stringify(swDupB));
    check('стара картка з іншого пристрою не повернулась', swDupA.join() === '20000001', JSON.stringify(swDupA));

    // ---------- 7. повірка зі зміною показників → робітнику; скасування ----------
    await A.run(async (a) => {
      const h = a.db.houses.find(q => q.meterNo === '10000002');
      a.openPovirka(h.id); await new Promise(r => setTimeout(r, 50));
      a.setState({ povDate: '2026-11-18', povChanged: true, povInstDate: '2026-11-20',
        povNewEn: '0', povNewVoda: '0', povNewNar: '0', povNewProst: '0' });
      await new Promise(r => setTimeout(r, 50)); a.savePovirka();
    });
    await wait(300); await syncNow(A); await syncNow(B);
    const pvB = await B.run(a => { const h = a.db.houses.find(q => q.meterNo === '10000002');
      return { pov: h.obcPovirka, prev: a._prevEnergy(h.id), recs: a._houseReadings(h.id).filter(r => r.povirka).length, hist: (h.meterPovirky || []).length }; });
    check('повірка: у робітника нова дата, запис «після повірки» й «попередній»', pvB.pov === '2026-11-18' && pvB.recs === 1 && pvB.prev === 0 && pvB.hist === 1, JSON.stringify(pvB));
    await A.run(async (a) => { const h = a.db.houses.find(q => q.meterNo === '10000002'); a.undoPovirka(h.id, h.meterPovirky[0].at); });
    await wait(300); await syncNow(A); await syncNow(B);
    const pvU = await B.run(a => { const h = a.db.houses.find(q => q.meterNo === '10000002');
      return { pov: h.obcPovirka, prev: a._prevEnergy(h.id), recs: a._houseReadings(h.id).filter(r => r.povirka).length, hist: (h.meterPovirky || []).length }; });
    check('скасування повірки дійшло до робітника', pvU.pov === '' && pvU.recs === 0 && pvU.prev === 205 && pvU.hist === 0, JSON.stringify(pvU));

    // ---------- 8. новий прилад і правка довідника старшим → робітнику ----------
    await A.run(async (a) => {
      a.openNewMeter(); await new Promise(r => setTimeout(r, 50));
      a.setState({ nmAddress: 'вул.Тестова, 7', nmOwner: 'Новий Абонент', nmAccount: 'Т007', nmMeterNo: '10000007', nmPrev: '50' });
      await new Promise(r => setTimeout(r, 50)); a.saveNewMeter();
      await new Promise(r => setTimeout(r, 100));
      // № акта в картці
      const h = a.db.houses.find(q => q.meterNo === '10000005');
      a.tapMeter(h); await new Promise(r => setTimeout(r, 100));
      a.setState({ mAkt: '44' }); await new Promise(r => setTimeout(r, 50)); a.saveDovidnyk();
    });
    await wait(300);
    await A.run(async (a) => { await a.cloudPublishBase(); });
    await syncNow(A); await syncNow(B);
    const nmB = await B.run(a => ({ n: a.db.houses.length, act5: a.db.houses.find(q => q.meterNo === '10000005').act,
      pend: a._pendingCount(), readings: a.db.readings.length }));
    check('новий прилад дійшов до робітника синхронізацією', nmB.n === 5, nmB.n + ' приладів');
    check('правка довідника (№ акта) дійшла до робітника', nmB.act5 === '44', '№ акта: ' + nmB.act5);
    check('робітник нічого не втратив', nmB.pend === 0 && nmB.readings >= 8, JSON.stringify(nmB));

    // ---------- 8б. база опублікована ДО заміни, робітник синхронізується ПІСЛЯ ----------
    // Опублікований довідник ще має старий № — злиття не сміє «відкотити» заміну.
    await A.run(async (a) => {
      const h = a.db.houses.find(q => q.meterNo === '10000002');
      a.tapMeter(h); await new Promise(r => setTimeout(r, 100));
      a.setState({ mAkt: '55' }); await new Promise(r => setTimeout(r, 50)); a.saveDovidnyk();
      await a.cloudPublishBase();
      const z = a.db.houses.find(q => q.meterNo === '10000003');
      a.openMeterSwap(z.id); await new Promise(r => setTimeout(r, 50));
      a.setState({ swapNewNo: '30000003', swapOldLast: '345', swapNewInit: '7', swapOldVoda: '770', swapNewVoda: '3', swapOldNar: '1750', swapNewNar: '1', swapOldProst: '12', swapNewProst: '0' });
      await new Promise(r => setTimeout(r, 50)); a.saveMeterSwap();
    });
    await wait(300); await syncNow(A); await syncNow(B);
    const mix = await B.run(async (a) => {
      const h2 = a.db.houses.find(q => q.account === 'Т002'), h3 = a.db.houses.find(q => q.account === 'Т003');
      a.tapMeter(h3); await new Promise(r => setTimeout(r, 150));
      return { act2: h2.act, no3: h3.meterNo, prev3: a._prevEnergy(h3.id), vodPrevInForm: a.state.tblVodPrev, swaps3: (h3.meterSwaps || []).length };
    });
    check('правка, опублікована до заміни, дійшла', mix.act2 === '55', '№ акта: ' + mix.act2);
    check('заміна після публікації не «відкотилась» злиттям довідника', mix.no3 === '30000003' && mix.prev3 === 7 && mix.swaps3 === 1, JSON.stringify(mix));
    check('«попередній» обʼєм води у робітника — з показання іншого пристрою', mix.vodPrevInForm === '3', 'у формі: ' + mix.vodPrevInForm);

    // ---------- 9. очищення попередніх періодів старшим → робітнику ----------
    await A.run(a => { a.setState({ purgeKey: '2026-04' }); });
    await wait(50);
    await A.run(a => a.purgePeriods());
    await wait(300); await syncNow(A); await syncNow(B);
    const pg = await B.run(a => ({ march: a.db.readings.filter(r => a._rPeriod(r) === '2026-03').length, total: a.db.readings.length, pb: a.state.purgeBefore }));
    check('очищення дійшло до робітника (березень видалено)', pg.march === 0 && pg.pb === '2026-04' && pg.total > 0, JSON.stringify(pg));

    // ---------- 10. завдання без зв'язку: зрозуміла помилка, потім доходить само ----------
    await A.ctx.setOffline(true);
    const offErr = await A.run(async (a) => {
      const k = 'a:т005';
      a.setState({ assignments: { ...(a.state.assignments || {}), [k]: 'Робітник Тест' }, assignmentsAt: { ...(a.state.assignmentsAt || {}), [k]: Date.now() } });
      await new Promise(r => setTimeout(r, 50));
      await a.cloudPublishAssign();
      return a.state.importError || '';
    });
    check('без зв’язку: зрозуміле повідомлення замість «Failed to fetch»', /немає зв/.test(offErr) && !/Failed to fetch/i.test(offErr), offErr.slice(0, 90));
    await A.ctx.setOffline(false);
    await syncNow(A); await syncNow(B);
    const asgB = await B.run(a => (a.state.assignments || {})['a:т005'] || '');
    check('завдання дійшло до робітника після появи зв’язку (звичайною синхронізацією)', asgB === 'Робітник Тест', asgB || 'нема');

    // ---------- 10б. різні виконавці для лічильників однієї адреси (таблиця маршруту) ----------
    const asgMulti = await A.run(async (a) => {
      a.setState({ tab: 'route', routeTable: true }); await new Promise(r => setTimeout(r, 300));
      a.setBuildingAssign('вул.Тестова, 1', 'Робітник Тест');          // будинку — один
      await new Promise(r => setTimeout(r, 150));
      const rowsOf = () => (a.renderVals().routeAll || []).filter(r => /Тестова, 1/.test(r.address));
      rowsOf()[1].onWorker({ target: { value: 'Інший Робітник' } });  // рядку (2) — інший
      await new Promise(r => setTimeout(r, 150));
      const hs = a.db.houses.filter(h => /Тестова, 1$/.test(h.address));
      const step1 = hs.map(h => a._assignedWorker(h));
      rowsOf()[0].onWorker({ target: { value: '' } });                 // з рядка (1) — зняти
      await new Promise(r => setTimeout(r, 150));
      return { rows: rowsOf().map(r => r.address + ': ' + (r.worker || '—')), step1, step2: hs.map(h => a._assignedWorker(h)) };
    });
    check('маршрут: різні виконавці для лічильників однієї адреси', asgMulti.step1.join() === 'Робітник Тест,Інший Робітник', JSON.stringify(asgMulti.step1));
    check('маршрут: зняття з одного рядка не чіпає інший', asgMulti.step2.join() === ',Інший Робітник', JSON.stringify(asgMulti.rows));
    await syncNow(A); await syncNow(B);
    const asgMultiB = await B.run(a => a.db.houses.filter(h => /Тестова, 1$/.test(h.address)).map(h => a._assignedWorker(h)));
    check('ці призначення дійшли до робітника', asgMultiB.join() === ',Інший Робітник', JSON.stringify(asgMultiB));

    // ---------- 10в. призначення лічильника переживає заміну приладу ----------
    const asgSwap = await A.run(async (a) => {
      const h = a.db.houses.find(q => q.account === 'Т005');
      a.setMetersAssign([h], 'Інший Робітник'); await new Promise(r => setTimeout(r, 100));
      a.openMeterSwap(h.id); await new Promise(r => setTimeout(r, 50));
      a.setState({ swapNewNo: '50000005', swapOldLast: '480', swapNewInit: '0' });
      await new Promise(r => setTimeout(r, 50)); a.saveMeterSwap(); await new Promise(r => setTimeout(r, 150));
      return { no: h.meterNo, w: a._assignedWorker(h) };
    });
    await syncNow(A); await syncNow(B);
    const asgSwapB = await B.run(a => { const h = a.db.houses.find(q => q.account === 'Т005'); return { no: h.meterNo, w: a._assignedWorker(h) }; });
    check('призначення лічильника не губиться після заміни (обидва пристрої)', asgSwap.no === '50000005' && asgSwap.w === 'Інший Робітник'
      && asgSwapB.no === '50000005' && asgSwapB.w === 'Інший Робітник', JSON.stringify([asgSwap, asgSwapB]));

    // ---------- 10г. «Оновити довідник з сервера»: № актів повертаються, показання лишаються ----------
    const rf = await B.run(async (a) => {
      const before = a.db.readings.length;
      a.db.houses.forEach(h => { h.act = ''; });             // як пристрій, що не мав номерів актів
      a._persist();
      await a.cloudRefreshBase(); await a._waitCloudIdle(15000);
      return { before, after: a.db.readings.length, acts: a.db.houses.filter(h => h.act).length, n: a.db.houses.length,
        found: a.db.houses.filter(h => a._matchesSearch(h, 'акт 44')).map(h => h.meterNo) };
    });
    check('«Оновити довідник»: № актів повернулись, показання на місці', rf.acts === rf.n && rf.after === rf.before && rf.found.length === 1, JSON.stringify(rf));

    // ---------- 10д. «Стан даних»: порівняння пристрою з сервером ----------
    const dgB = await B.run(async (a) => { await a.cloudCompare(); return a._diagView(); });
    check('«Стан даних» у робітника: збігається з сервером', /збігається/.test(dgB.diagHint), dgB.diagLocalTxt + ' | ' + dgB.diagSrvTxt);
    const dgA = await A.run(async (a) => {
      // на ПК додали прилад і НЕ опублікували базу — у старшого даних більше, ніж на сервері
      a.openNewMeter(); await new Promise(r => setTimeout(r, 50));
      a.setState({ nmAddress: 'вул.Тестова, 9', nmMeterNo: '10000009', nmAccount: 'Т009' }); await new Promise(r => setTimeout(r, 50));
      a.saveNewMeter(); await new Promise(r => setTimeout(r, 100));
      await a.cloudCompare(); return a._diagView();
    });
    check('«Стан даних» у старшого: неопубліковані правки видно (і вони підуть самі)', /Опублікувати базу|автоматично/.test(dgA.diagHint), dgA.diagHint);

    // ---------- 10е. АВТОМАТИКА: правка довідника доходить без «Опублікувати базу» ----------
    await A.run(async (a) => {
      const h = a.db.houses.find(q => q.account === 'Т002');
      a.tapMeter(h); await new Promise(r => setTimeout(r, 100));
      a.setState({ mAkt: '77' }); await new Promise(r => setTimeout(r, 50)); a.saveDovidnyk();
    });
    await syncNow(A); await syncNow(A); await syncNow(B);
    const auto = await B.run(async (a) => {
      const h2 = a.db.houses.find(q => q.account === 'Т002'), h9 = a.db.houses.find(q => q.account === 'Т009');
      return { act2: h2 && h2.act, newMeter: !!h9, hint: a._diagView().diagHint };
    });
    const aDirty = await A.run(a => a.state.baseDirty);
    check('автоматично: № акта з картки старшого дійшов до робітника', auto.act2 === '77', JSON.stringify(auto));
    check('автоматично: новий прилад старшого дійшов до робітника', auto.newMeter, JSON.stringify(auto));
    check('автоматично: «Стан даних» у робітника — збігається (без кнопки)', /збігається/.test(auto.hint), auto.hint);
    check('автоматично: у старшого правки позначено надісланими', aDirty === false, String(aDirty));

    // ---------- 10є. показання НЕ зникають, коли змінюються дані приладу ----------
    // Ключ показання будується з даних приладу (особовий, вид обліку, №). Якщо вид
    // обліку змінили, пристрої не мають «загубити» вже синхронізовані показання.
    const cnt = (d) => d.run(a => { const h = a.db.houses.find(q => q.account === 'Т002'); return a._houseReadings(h.id).length; });
    await enter(B, '10000002', 210);                       // свіже показання робітника
    await syncNow(B); await syncNow(A);
    const beforeA = await cnt(A), beforeB = await cnt(B);
    await A.run(async (a) => {
      const h = a.db.houses.find(q => q.account === 'Т002');
      a.tapMeter(h); await new Promise(r => setTimeout(r, 100));
      a.setState({ mKomOblik: true }); await new Promise(r => setTimeout(r, 50)); a.saveDovidnyk();   // росп. → ком.
    });
    for (let i = 0; i < 2; i++) { await syncNow(A); await syncNow(B); }
    const afterA = await cnt(A), afterB = await cnt(B);
    const kindB = await B.run(a => a._meterKind(a.db.houses.find(q => q.account === 'Т002')));
    check('зміна виду обліку дійшла до робітника', kindB === 'kom', kindB);
    check('показання не зникли після зміни даних приладу (обидва пристрої)', afterA === beforeA && afterB === beforeB,
      'старший ' + beforeA + '→' + afterA + ', робітник ' + beforeB + '→' + afterB);

    // ---------- 10ж. застаріла відкрита картка не затирає правку з іншого пристрою ----------
    const stale = await A.run(async (a) => {
      const h = a.db.houses.find(q => q.account === 'Т005');
      a.tapMeter(h); await new Promise(r => setTimeout(r, 100));          // картку відкрито (№ акта «44»)
      h.act = '91';                                                          // тим часом прийшло з іншого пристрою
      a.setState({ mPhone: '+380 50 111 22 33' }); await new Promise(r => setTimeout(r, 50));
      a.saveDovidnyk(); await new Promise(r => setTimeout(r, 50));          // тут змінили лише телефон
      return { act: h.act, phone: h.phone };
    });
    check('збереження картки пише лише змінені поля (чужий № акта не затерто)', stale.act === '91' && /111/.test(stale.phone), JSON.stringify(stale));

    // ---------- 10з. показання доходить без ручної синхронізації ----------
    await B.run(async (a) => { await a._waitCloudIdle(15000); });
    await enter(B, '10000002', 215);                                         // saveReading сам запускає синхронізацію
    await wait(4000);
    await syncNow(A);
    const fast = await A.run(a => { const h = a.db.houses.find(q => q.account === 'Т002'); const l = a._lastReading(h.id); return l ? l.cur : null; });
    check('показання робітника пішло на сервер одразу після збереження', fast === 215, String(fast));

    // ---------- 10и. виконавець для приладу БЕЗ № лічильника («?» в акті) ----------
    const noNum = await A.run(async (a) => {
      a.openNewMeter(); await new Promise(r => setTimeout(r, 50));
      a.setState({ nmAddress: 'вул. Ігнатенка, 6', nmMeterNo: 'X', nmAccount: 'ІГНАТЕНКА6' }); await new Promise(r => setTimeout(r, 50));
      a.saveNewMeter(); await new Promise(r => setTimeout(r, 100));
      const h = a.db.houses.find(q => q.account === 'ІГНАТЕНКА6'); h.meterNo = ''; a._touchHouse(h); a._persist();   // номера немає
      a.setState({ tab: 'route', routeTable: true }); await new Promise(r => setTimeout(r, 300));
      const row = (a.renderVals().routeAll || []).find(r => /Ігнатенка, 6/.test(r.address));
      row.onWorker({ target: { value: 'Кравченко В. І.' } }); await new Promise(r => setTimeout(r, 150));
      return a._assignedWorker(h);
    });
    for (let i = 0; i < 2; i++) { await syncNow(A); await syncNow(B); }
    const noNumB = await B.run(a => { const h = a.db.houses.find(q => q.account === 'ІГНАТЕНКА6'); return h ? a._assignedWorker(h) : 'немає приладу'; });
    check('виконавець приладу без № лічильника — видно на обох пристроях', noNum === 'Кравченко В. І.' && noNumB === 'Кравченко В. І.', noNum + ' / ' + noNumB);

    // ---------- 10і. правка № лічильника й інших полів у картці доходить без дубля ----------
    const nBefore = await B.run(a => a.db.houses.length);
    await A.run(async (a) => {
      const h = a.db.houses.find(q => q.account === 'ІГНАТЕНКА6');
      a.tapMeter(h); await new Promise(r => setTimeout(r, 100));
      a.setState({ mObcZavod: '6666666', mAkt: '331', mSettlement: 'Ігнатенка, 6' }); await new Promise(r => setTimeout(r, 50));
      a.saveDovidnyk();
    });
    for (let i = 0; i < 2; i++) { await syncNow(A); await syncNow(B); }
    const ren = await B.run(a => { const hs = a.db.houses.filter(q => q.account === 'ІГНАТЕНКА6');
      return { n: a.db.houses.length, same: hs.length, no: hs.map(h => h.meterNo), act: hs.map(h => h.act), st: hs.map(h => h.settlement),
        w: hs.map(h => a._assignedWorker(h)) }; });
    check('правка № лічильника в картці: у робітника той самий прилад, без дубля', ren.same === 1 && ren.n === nBefore && ren.no[0] === '6666666', JSON.stringify(ren));
    check('правка картки: № акта й нас. пункт дійшли', ren.act[0] === '331' && ren.st[0] === 'Ігнатенка, 6', JSON.stringify(ren));
    check('правка № лічильника: виконавець лишився', ren.w[0] === 'Кравченко В. І.', JSON.stringify(ren.w));

    // ---------- 10ї. дубль приладу: видалення на одному пристрої прибирає його всюди ----------
    const dup = await A.run(async (a) => {
      // дубль, як після старої помилки: той самий особовий, старий № (порожній), без нас. пункту
      const real = a.db.houses.find(q => q.account === 'ІГНАТЕНКА6');
      const id = a.db.houses.reduce((m, h) => Math.max(m, h.id), 0) + 1;
      const d = Object.assign({}, real, { id, meterNo: '', settlement: '', act: '', prevKeys: [], upAt: Date.now() - 1000 });
      a.db.houses.push(d); a._touchHouse(d); d.upAt = Date.now() - 1000; a._persist();
      return { id, n: a.db.houses.filter(q => q.account === 'ІГНАТЕНКА6').length };
    });
    for (let i = 0; i < 2; i++) { await syncNow(A); await syncNow(B); }
    const dupB = await B.run(a => a.db.houses.filter(q => q.account === 'ІГНАТЕНКА6').length);
    await A.run(async (a, id) => { a.deleteMeter(id); }, dup.id);
    for (let i = 0; i < 2; i++) { await syncNow(A); await syncNow(B); }
    const afterDel = await B.run(a => a.db.houses.filter(q => q.account === 'ІГНАТЕНКА6').map(h => h.meterNo));
    const afterDelA = await A.run(a => a.db.houses.filter(q => q.account === 'ІГНАТЕНКА6').map(h => h.meterNo));
    check('дубль з’явився на обох (як у реальній ситуації)', dup.n === 2 && dupB === 2, dup.n + ' / ' + dupB);
    check('«Видалити прилад» прибрав дубль на обох пристроях, справжній лишився', afterDel.join() === '6666666' && afterDelA.join() === '6666666', JSON.stringify([afterDelA, afterDel]));

    // ---------- 10ї'. зміна № у картці + стара копія з іншого пристрою — без другої картки ----------
    const ren7 = await A.run(async (a) => {
      const h = a.db.houses.find(q => q.account === 'Т007');
      const stale = JSON.parse(JSON.stringify(h));               // як на пристрої, що ще не знає про правку
      a.tapMeter(h); await new Promise(r => setTimeout(r, 100));
      a.setState({ mObcZavod: '70000007' }); await new Promise(r => setTimeout(r, 50));
      a.saveDovidnyk(); await new Promise(r => setTimeout(r, 100));
      return { stale, no: h.meterNo };
    });
    for (let i = 0; i < 2; i++) { await syncNow(A); await syncNow(B); }
    // застарілий пристрій публікує картку зі старим № (і новішою міткою часу)
    await A.run(async (a, st) => {
      await a._apiFetch('/base', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'merge', houses: [Object.assign({}, st, { upAt: Date.now() + 1000 })], boilers: [] }) });
    }, ren7.stale);
    for (let i = 0; i < 2; i++) { await syncNow(A); await syncNow(B); }
    await B.run(async (a) => { await a.cloudRefreshBase(); await a._waitCloudIdle(15000); });
    const ren7B = await B.run(a => a.db.houses.filter(q => q.account === 'Т007').map(h => h.meterNo));
    const ren7S = await A.run(async (a) => { const r = await a._apiFetch('/base'); const d = await r.json(); return d.houses.filter(h => h.account === 'Т007').map(h => h.meterNo); });
    check('зміна № у картці: стара копія не стала другим приладом (пристрій і сервер)', ren7.no === '70000007'
      && ren7B.join() === '70000007' && ren7S.join() === '70000007', JSON.stringify([ren7B, ren7S]));

    // ---------- 10й. перенесення показань у попередній період доходить до всіх ----------
    const mv = await A.run(async (a) => {
      const f = a.db.readings.filter(r => r.src === 'field' && r.date && !r.isControl);
      if (!f.length) return null;
      const day = f[0].date, rs = f.filter(r => r.date === day);
      const from = a._rPeriod(rs[0]), to = a._prevMonthKey(from);
      a.moveReadingsPeriod(rs.map(r => r.id), to, 'тест');
      const sig = (r) => r.date + '|' + (r.meterNo || '') + '|' + r.cur;
      return { sigs: rs.map(sig), from, to, localA: rs.map(r => a._rPeriod(r)) };
    });
    check('є польові показання для переносу', !!mv);
    if (mv) {
      for (let i = 0; i < 2; i++) { await syncNow(A); await syncNow(B); }
      const onB = await B.run((a, sigs) => a.db.readings
        .filter(r => sigs.includes(r.date + '|' + (r.meterNo || '') + '|' + r.cur)).map(r => a._rPeriod(r)), mv.sigs);
      check('перенос у ' + mv.to + ' — у старшого', mv.localA.every(p => p === mv.to), JSON.stringify(mv.localA));
      check('перенос у ' + mv.to + ' дійшов до робітника, без дублів', onB.length === mv.sigs.length && onB.every(p => p === mv.to), JSON.stringify(onB));
    }

    // ---------- 10к. оператор ФОП: лише особові «П», мітка «заведено» доходить до старшого ----------
    await A.run(async (a) => { a.setState({ nuName: 'Оператор Тест', nuPin: '3333', nuLvl: 'operator' }); await new Promise(r => setTimeout(r, 50)); await a.addUser(); });
    await wait(400);
    // прилад з особовим «П…» і показанням — через ті самі акти
    const xlsxP = await A.page.evaluate(() => {
      const aoa = [
        ['№', 'Дата', 'Адреса', 'Споживач', 'Особовий рахунок', '№ лічильника', 'Ком. облік (№ у рамці)', 'Вид обліку',
          'Кількість теплової енергії по лічильнику', '', '', "Об'єм води по теплолічильнику, м3", '', 'Наробітка теплолічильника, дні/години', '', 'Простой теплолічильника, год.', ''],
        ['', '', '', '', '', '', '', '', 'Од. виміру', 'Попереднє', 'Теперішнє', 'Попереднє', 'Теперішнє', 'Попереднє', 'Теперішнє', 'Попереднє', 'Теперішнє'],
        [9, '27.03.2026', 'вул.Тестова, 21', 'ФОП Тест', 'П021', '20000021', 21, 'ком.', 'Гкал', 50, 57.5, 10, 12, 100, 200, 0, 0]
      ];
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(aoa), 'Акти');
      return Array.from(new Uint8Array(window.XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
    });
    await A.page.setInputFiles('#dbImportInput', { name: 'akty-p.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from(xlsxP) });
    await wait(1200);
    await A.run(a => { a.setState({ actsClear: false }); });
    await wait(100);
    await A.run(a => a.confirmActsPlan());
    await wait(400);
    await A.run(async (a) => { await a.cloudPublishBase(); });
    await wait(300);
    await syncNow(A);
    const O = await device(browser, 'ПК оператора ФОП');
    await O.run(async (a, k) => { a.setState({ keyInput: k }); await new Promise(r => setTimeout(r, 50)); a.saveBrigadeKey(); }, key);
    await wait(900);
    await O.run(async (a) => { const u = a.state.users.find(x => x.name === 'Оператор Тест'); a.setState({ loginSel: u.id, loginPin: '3333' }); await new Promise(r => setTimeout(r, 50)); a.doLogin(); });
    await wait(300);
    await O.run(async (a) => { await a.cloudLoadBase(); });
    await wait(1500);
    await syncNow(O);
    const op = await O.run(async (a) => {
      a.setState({ fopMonth: '2026-03', fopFilter: 'all' }); await new Promise(r => setTimeout(r, 50));
      const v = a.renderVals();
      return { tab: a.state.tab, tabs: v.tabs.map(t => t.label), isFop: v.isFop,
        accs: v.fopCards.map(c => c.fields.find(f => f.label === 'Особовий').val) };
    });
    check('оператор: лише вкладка ФОП', op.isFop && op.tabs.join() === 'ФОП', JSON.stringify(op));
    check('оператор: показані лише особові «П» зняті за місяць', op.accs.join() === 'П021', JSON.stringify(op.accs));
    await O.run(async (a) => { a.setState({ fopMonth: '2026-03', fopFilter: 'all' }); await new Promise(r => setTimeout(r, 30)); a.renderVals().fopCards[0].toggle(); });
    await wait(200);
    for (let i = 0; i < 2; i++) { await syncNow(O); await syncNow(A); }
    const markA = await A.run(a => Object.entries(a.state.fopMarks || {}).map(([k, m]) => k + '=' + (m.v ? 'так' : 'ні') + '/' + m.by));
    check('мітка «заведено» оператора дійшла до старшого', markA.length === 1 && /п021\|20000021\|2026-03=так\/Оператор Тест/i.test(markA[0]), JSON.stringify(markA));
    const notYet = await O.run(async (a) => { a.setState({ fopFilter: 'todo' }); await new Promise(r => setTimeout(r, 30)); return a.renderVals().fopCards.length; });
    check('оператор: заведений зник із «Не заведено»', notYet === 0, String(notYet));
    check('немає JS-помилок (оператор)', O.errors.length === 0, O.errors.slice(0, 2).join(' | '));
    await O.ctx.close();

    // ---------- 11. помилок JS немає ----------
    check('немає JS-помилок (старший)', A.errors.length === 0, A.errors.slice(0, 2).join(' | '));
    check('немає JS-помилок (робітник)', B.errors.length === 0, B.errors.slice(0, 2).join(' | '));
  } catch (e) {
    check('сценарій виконано без винятків', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
  }
  await finish();
  process.exit(fail);
})();
