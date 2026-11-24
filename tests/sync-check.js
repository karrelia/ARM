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

    // ---------- 10. помилок JS немає ----------
    check('немає JS-помилок (старший)', A.errors.length === 0, A.errors.slice(0, 2).join(' | '));
    check('немає JS-помилок (робітник)', B.errors.length === 0, B.errors.slice(0, 2).join(' | '));
  } catch (e) {
    check('сценарій виконано без винятків', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
  }
  await finish();
  process.exit(fail);
})();
