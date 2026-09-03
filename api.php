<?php
/*
 * АРМ Теплооблік — PHP-бекенд для розгортання на Apache (Ubuntu).
 * Повний аналог server.js: ті самі маршрути й формат відповідей, але
 * без окремого Node-процесу — Apache сам виконує PHP на кожен запит.
 *
 * Розгортання:
 *   1) Покладіть api.php і .htaccess у теку сайту (там же index.html, support.js, vendor/).
 *   2) Переконайтесь, що встановлено PHP (apt install php libapache2-mod-php) і
 *      Apache перезапущено.
 *   3) Дані зберігаються у теці  arm-data/  поряд із api.php. Веб-серверу
 *      (користувач www-data) потрібне право запису в цю теку:
 *         sudo mkdir -p arm-data && sudo chown www-data:www-data arm-data
 *
 * Маршрутизація:
 *   • Красиві URL  /api/xxx   працюють, якщо ввімкнено mod_rewrite + AllowOverride
 *     (див. .htaccess).
 *   • Прямі URL    /api.php/xxx  працюють ЗАВЖДИ, навіть без mod_rewrite —
 *     клієнт автоматично визначає, який шлях доступний.
 *
 * Увага: фото передаються як data URL у складі показань. Щоб великі пакети
 * не обрізались, у php.ini бажано  post_max_size = 64M  (і  upload_max_filesize).
 */

// Застосунок і API живуть на одному походженні — CORS-заголовків свідомо немає
// (раніше стояло Access-Control-Allow-Origin: *, що дозволяло чужим сайтам
// звертатись до API з браузера будь-якого відвідувача).
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') { http_response_code(204); exit; }

$DATA_DIR   = __DIR__ . '/arm-data';
$DB_FILE    = $DATA_DIR . '/db.json';
$USERS_FILE = $DATA_DIR . '/users.json';
$PHOTOS_DIR = $DATA_DIR . '/photos';   // фото винесені з db.json в окремі файли

// ---------- визначення маршруту ----------
// Для /api.php/xxx  беремо PATH_INFO. Для переписаного /api/xxx  дістаємо
// хвіст із REQUEST_URI (mod_rewrite зберігає оригінальний URI).
function route() {
    if (!empty($_SERVER['PATH_INFO'])) return trim($_SERVER['PATH_INFO'], '/');
    $uri = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH) ?: '';
    $uri = rawurldecode($uri);
    // відкидаємо все до /api/ або /api.php/
    if (preg_match('#/api\.php/(.*)$#', $uri, $m)) return trim($m[1], '/');
    if (preg_match('#/api/(.*)$#',      $uri, $m)) return trim($m[1], '/');
    return '';
}

function send_json($code, $obj) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($obj, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
function read_body() {
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) return array();
    $j = json_decode($raw, true);
    return is_array($j) ? $j : array();
}

// ---------- сховище ----------
function empty_db() {
    return array('houses' => array(), 'boilers' => array(), 'readings' => array(),
                 'assignments' => new stdClass(), 'assignmentsAt' => new stdClass(), 'contacts' => new stdClass(), 'routes' => new stdClass(),
                 'closedAt' => 0, 'periodKey' => '', 'periodAt' => 0,
                 'deletes' => new stdClass(), 'swaps' => new stdClass(), 'baseSig' => '', 'savedAt' => 0);
}
// Розподіл зводиться по КЛЮЧАХ із мітками часу (як contacts/routes), а не цілою
// мапою — інакше два старших/адміни затирають правки одне одного (розподіл «блимає»).
// Наявним призначенням без мітки даємо базову «1». Порожній виконавець — тумбстоун.
function ensure_asg_stamps(&$db) {
    if (!isset($db['assignmentsAt']) || !is_array($db['assignmentsAt'])) $db['assignmentsAt'] = array();
    if (isset($db['assignments']) && is_array($db['assignments']))
        foreach ($db['assignments'] as $k => $v) if (empty($db['assignmentsAt'][$k])) $db['assignmentsAt'][$k] = 1;
}
function merge_assignments(&$db, $incAssign, $incAt) {
    ensure_asg_stamps($db);
    if (!is_array($incAt)) return;   // без міток (старий клієнт) — не чіпаємо, щоб не затер
    if (!is_array($incAssign)) $incAssign = array();
    if (!is_array($db['assignments'])) $db['assignments'] = array();
    foreach ($incAt as $k => $at) {
        $at = (float)$at;
        if ($at >= (float)($db['assignmentsAt'][$k] ?? 0)) {
            $w = isset($incAssign[$k]) ? $incAssign[$k] : '';
            if ($w !== '' && $w !== null) $db['assignments'][$k] = $w; else unset($db['assignments'][$k]);
            $db['assignmentsAt'][$k] = $at;
        }
    }
}
// ---------- ключ бригади (захист API на публічному хостингу) ----------
// Без нього будь-хто в інтернеті міг скачати користувачів (PIN — 4 цифри,
// підбирається миттєво), адреси/телефони з бази чи залити фейкові показання.
// Ключ генерується один раз у arm-data/config.json ("brigadeKey"); старший
// вводить його на пристроях (розділ «Виконавець»), клієнт шле заголовком
// X-Brigade-Key. Без ключа доступні лише /ping і фото (їх sha1-адреса — секрет).
// ---------- тека даних: створення + самозахист від прямого доступу ----------
// Кореневий .htaccess закриває arm-data/ лише за наявності mod_rewrite чи
// mod_alias, а README прямо дозволяє розгортання без них. Тому кладемо ЩЕ ОДИН
// .htaccess у саму теку: «Require all denied» діє через mod_authz_core, який в
// Apache 2.4 присутній завжди. Інакше повна база з персональними даними
// (зокрема бекапи arm-data/backup/db-РРРР-ММ-ДД.json, яких немає в переліку
// кореневого FilesMatch) качається за прямим URL.
define('DATA_HTACCESS',
    "# Тека даних АРМ Теплооблік: db.json, users.json, config.json (ключ API),\n" .
    "# бекапи та фото. Створюється сервером автоматично — не редагуйте.\n" .
    "# Прямий доступ через веб заборонено: дані віддаються ЛИШЕ через api.php\n" .
    "# (з ключем бригади) або server.js.\n" .
    "<IfModule mod_authz_core.c>\n" .      // Apache 2.4
    "  Require all denied\n" .
    "</IfModule>\n" .
    "<IfModule !mod_authz_core.c>\n" .     // Apache 2.2
    "  Order allow,deny\n" .
    "  Deny from all\n" .
    "</IfModule>\n");
function ensure_data_dir() {
    global $DATA_DIR;
    if (!is_dir($DATA_DIR)) @mkdir($DATA_DIR, 0775, true);
    // best-effort і самолікування: якщо теку створили руками (як радить README),
    // захист доїде з першим же записом
    $f = $DATA_DIR . '/.htaccess';
    if (!is_file($f)) @file_put_contents($f, DATA_HTACCESS);
}
function brigade_key() {
    global $DATA_DIR;
    $file = $DATA_DIR . '/config.json';
    $cfg = array();
    $s = @file_get_contents($file);
    if ($s !== false) { $j = json_decode($s, true); if (is_array($j)) $cfg = $j; }
    if (empty($cfg['brigadeKey'])) {
        $cfg['brigadeKey'] = bin2hex(random_bytes(16));
        ensure_data_dir();
        @file_put_contents($file, json_encode($cfg, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), LOCK_EX);
    }
    return (string)$cfg['brigadeKey'];
}
function key_ok() {
    $got = $_SERVER['HTTP_X_BRIGADE_KEY'] ?? '';
    return hash_equals(brigade_key(), (string)$got);
}
function load_db() {
    global $DB_FILE;
    $s = @file_get_contents($DB_FILE);
    if ($s === false) return empty_db();
    $j = json_decode($s, true);
    if (!is_array($j)) return empty_db();
    // гарантуємо наявність ключів
    $d = empty_db();
    foreach (array('houses','boilers','readings','baseSig','savedAt') as $k)
        if (isset($j[$k])) $d[$k] = $j[$k];
    if (isset($j['assignments'])) $d['assignments'] = $j['assignments'];
    if (isset($j['assignmentsAt'])) $d['assignmentsAt'] = $j['assignmentsAt'];
    if (isset($j['contacts'])) $d['contacts'] = $j['contacts'];
    if (isset($j['routes'])) $d['routes'] = $j['routes'];
    // closedAt/deletes теж мусять переживати перезавантаження (раніше не читались —
    // «закриття місяця» скидалось, а тумбстоуни видалення не трималися між запитами)
    if (isset($j['closedAt'])) $d['closedAt'] = $j['closedAt'];
    if (isset($j['periodKey'])) $d['periodKey'] = $j['periodKey'];
    if (isset($j['periodAt'])) $d['periodAt'] = $j['periodAt'];
    if (isset($j['deletes'])) $d['deletes'] = $j['deletes'];
    if (isset($j['swaps'])) $d['swaps'] = $j['swaps'];
    return $d;
}
// Спільні мапи бригади «будинок → запис із міткою часу»: contacts (контактна
// особа; одна адреса — один контакт для ХВ і ГВ) та routes (домовленості).
// Новіший at перемагає; «порожній» запис — ТУМБСТОУН видалення, він зберігається
// й розповсюджується (інакше інші пристрої повернуть стертий запис назад).
function merge_stamped_map($target, $incoming, $fields) {
    $out = is_array($target) ? $target : array();
    if (!is_array($incoming)) return $out;
    foreach ($incoming as $k => $inc) {
        if (!is_array($inc)) continue;
        $exAt = isset($out[$k]['at']) ? (float)$out[$k]['at'] : -1;
        $incAt = isset($inc['at']) ? (float)$inc['at'] : 0;
        if (!isset($out[$k]) || $incAt >= $exAt) {
            $rec = array('at' => $incAt ?: round(microtime(true) * 1000));
            foreach ($fields as $f) $rec[$f] = isset($inc[$f]) ? (string)$inc[$f] : '';
            $out[$k] = $rec;
        }
    }
    return $out;
}
function merge_contacts(&$db, $incoming) {
    $db['contacts'] = merge_stamped_map($db['contacts'] ?? array(), $incoming, array('name', 'phone'));
}
function merge_routes(&$db, $incoming) {
    $db['routes'] = merge_stamped_map($db['routes'] ?? array(), $incoming, array('mode', 'date', 'time', 'note'));
}
// Щоденна резервна копія db.json (знімок попереднього стану при першій зміні
// за день; тримаємо 30 днів) — захист історії показань від збою чи помилки.
function backup_db() {
    global $DATA_DIR, $DB_FILE;
    if (!is_file($DB_FILE)) return;
    $dir = $DATA_DIR . '/backup';
    ensure_data_dir();
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    $file = $dir . '/db-' . gmdate('Y-m-d') . '.json';
    if (is_file($file)) return;
    @copy($DB_FILE, $file);
    $keep = time() - 30 * 24 * 3600;
    foreach (glob($dir . '/db-*.json') ?: array() as $f) {
        if (preg_match('#/db-(\d{4}-\d{2}-\d{2})\.json$#', $f, $m) && strtotime($m[1]) < $keep) @unlink($f);
    }
}
function save_db($db) {
    global $DATA_DIR, $DB_FILE;
    ensure_data_dir();
    backup_db();
    $tmp = $DB_FILE . '.tmp';
    file_put_contents($tmp, json_encode($db, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), LOCK_EX);
    @rename($tmp, $DB_FILE);
}
function load_users() {
    global $USERS_FILE;
    $s = @file_get_contents($USERS_FILE);
    if ($s === false) return array();
    $j = json_decode($s, true);
    return (is_array($j) && isset($j['users']) && is_array($j['users'])) ? $j['users'] : array();
}
function save_users($users) {
    global $DATA_DIR, $USERS_FILE;
    ensure_data_dir();
    $tmp = $USERS_FILE . '.tmp';
    file_put_contents($tmp, json_encode(array('version' => 1, 'users' => $users),
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT), LOCK_EX);
    @rename($tmp, $USERS_FILE);
}

// ---------- фото: винесення data:URL у файли (щоб db.json не роздувався) ----------
// Повертає посилання «srv:<id>» замість base64. id = sha1 вмісту (дедуплікація).
function store_photo($dataUrl) {
    global $PHOTOS_DIR;
    if (!is_string($dataUrl) || strpos($dataUrl, 'data:') !== 0) return $dataUrl; // вже посилання або сміття
    $comma = strpos($dataUrl, ',');
    if ($comma === false) return $dataUrl;
    $b64 = substr($dataUrl, $comma + 1);
    $bin = base64_decode($b64, true);
    if ($bin === false || strlen($bin) === 0) return $dataUrl;
    $id = 'p_' . sha1($bin);
    ensure_data_dir();
    if (!is_dir($PHOTOS_DIR)) @mkdir($PHOTOS_DIR, 0775, true);
    $path = $PHOTOS_DIR . '/' . $id . '.jpg';
    if (!is_file($path)) file_put_contents($path, $bin, LOCK_EX);
    return 'srv:' . $id;
}
function externalize_photos(&$rec) {
    if (!isset($rec['photos']) || !is_array($rec['photos'])) return;
    $out = array();
    foreach ($rec['photos'] as $p) $out[] = store_photo($p);
    $rec['photos'] = $out;
}

// ---------- OCR-контроль: розпізнавання показника з фото хмарною моделлю ----------
// Ключ/модель беруться з env (ARM_ANTHROPIC_KEY / ARM_OCR_MODEL) або з файлу
// arm-data/config.json {"anthropicKey":"...","ocrModel":"..."} — щоб працювало й
// на Apache, де задати env для PHP незручно. Файл у arm-data/ (не в репозиторії).
define('OCR_PROMPT', "На фото — дисплей лічильника теплової енергії. Розпізнай головне числове показання (наростаюче значення на табло). Поверни ЛИШЕ це число: цифри, десятковий роздільник — крапка, без пробілів, одиниць та будь-якого іншого тексту. Якщо число не читається — поверни одне слово: null");
function ocr_config() {
    global $DATA_DIR;
    $key = getenv('ARM_ANTHROPIC_KEY') ?: (getenv('ANTHROPIC_API_KEY') ?: '');
    $model = getenv('ARM_OCR_MODEL') ?: '';
    $base = getenv('ARM_ANTHROPIC_URL') ?: '';
    $cfgFile = $DATA_DIR . '/config.json';
    if (is_file($cfgFile)) {
        $c = json_decode(@file_get_contents($cfgFile), true);
        if (is_array($c)) {
            if ($key === '' && !empty($c['anthropicKey'])) $key = $c['anthropicKey'];
            if ($model === '' && !empty($c['ocrModel'])) $model = $c['ocrModel'];
            if ($base === '' && !empty($c['anthropicUrl'])) $base = $c['anthropicUrl'];
        }
    }
    if ($model === '') $model = 'claude-opus-4-8';
    if ($base === '') $base = 'https://api.anthropic.com';
    return array('key' => $key, 'model' => $model, 'base' => rtrim($base, '/'));
}
function ocr_parse_number($t) {
    if (!preg_match('/-?\d[\d \x{00a0}]*(?:[.,]\d+)?/u', (string)$t, $m)) return null;
    $n = preg_replace('/[ \x{00a0}]/u', '', $m[0]);
    $n = str_replace(',', '.', $n);
    return is_numeric($n) ? (float)$n : null;
}

// ---------- зведення показань (дзеркалить server.js / клієнтський _mergeReadings) ----------
// нормалізація ключа — ТОЧНО як клієнтський _normAddr (JS .toLowerCase()) і
// server.js. КРИТИЧНО: strtolower НЕ переводить кирилицю в нижній регістр, тож
// «КАРБАНА20» лишалося б у верхньому — і ключ тумбстоуна видалення (клієнт дає
// «карбана20») не збігався б із показанням → видалення не розносилось. Тому
// mb_strtolower (UTF-8), як у JS. Плюс стискаємо внутрішні пробіли.
function norm_s($s) {
    $s = trim((string)($s === null ? '' : $s));
    $s = function_exists('mb_strtolower') ? mb_strtolower($s, 'UTF-8') : strtolower($s);
    return preg_replace('/\s+/', ' ', $s);
}
// wt (тип води) у ключі — щоб ХВ і ГВ одного особового рахунку за одну дату не
// злипались в одне показання (інакше історія одного з приладів втрачається).
// № лічильника — ОБОВ'ЯЗКОВА частина ключа: у будинку буває два прилади з
// ОДНАКОВИМ особовим і типом води; без нього друге показання затирало перше.
function key_of($r) {
    return legacy_key_of($r) . '|' . norm_s($r['meterNo'] ?? '');
}
function legacy_key_of($r) {
    $ctrl = !empty($r['isControl']) ? 'k' : '';
    return norm_s($r['account'] ?? '') . '|' . ($r['date'] ?? '') . '|' . ($r['wt'] ?? '') . '|' . $ctrl;
}
function merge_readings(&$db, $incoming) {
    $now = round(microtime(true) * 1000); // мс, як Date.now()
    $index = array(); $legacyIndex = array();
    foreach ($db['readings'] as $i => $r) { $index[key_of($r)] = $i;
        $lk = legacy_key_of($r); if (!isset($legacyIndex[$lk])) $legacyIndex[$lk] = $i; }
    $added = 0; $updated = 0; $conflicts = 0; $skipped = 0;
    foreach (($incoming ?: array()) as $inc) {
        if (!is_array($inc) || empty($inc['account'])) { $skipped++; continue; }
        $rec = $inc;
        unset($rec['houseId']); unset($rec['srvAt']);
        $rec['synced'] = true;
        externalize_photos($rec);   // base64 → файли, у db.json лише посилання
        $k = key_of($rec);
        // запис, збережений ДО появи № у ключі, підхоплюємо за старим ключем і
        // «всиновлюємо» (доповнюємо номером) — інакше вийшов би дубль тієї самої дати
        $slot = isset($index[$k]) ? $index[$k] : null;
        if ($slot === null && !empty($rec['meterNo'])) {
            $lk = legacy_key_of($rec);
            if (isset($legacyIndex[$lk]) && empty($db['readings'][$legacyIndex[$lk]]['meterNo'])) $slot = $legacyIndex[$lk];
        }
        if ($slot === null) {
            $rec['srvAt'] = $now;
            $db['readings'][] = $rec;
            $index[$k] = count($db['readings']) - 1;
            $added++;
        } else {
            $ex =& $db['readings'][$slot];
            $differ = (($ex['cur'] ?? null) !== ($rec['cur'] ?? null)) || (($ex['prev'] ?? null) !== ($rec['prev'] ?? null));
            if ((($rec['at'] ?? 0) > ($ex['at'] ?? 0))) {
                foreach ($rec as $kk => $vv) $ex[$kk] = $vv;
                $ex['srvAt'] = $now;
                $updated++;
                if ($differ) $conflicts++;
            } elseif ($differ) { $conflicts++; }
            unset($ex);
        }
    }
    return array('added' => $added, 'updated' => $updated, 'conflicts' => $conflicts, 'skipped' => $skipped);
}
function max_srv_at($db) {
    $m = 0;
    foreach ($db['readings'] as $r) if (($r['srvAt'] ?? 0) > $m) $m = $r['srvAt'];
    return $m;
}
// assignments/contacts мають завжди серіалізуватись як об'єкт (не порожній масив)
function assign_out($a) {
    if (is_array($a) && count($a) === 0) return new stdClass();
    return $a;
}

// ---------- обробка ----------
$path   = route();
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// GET /ping — перевірка наявності сервера (єдиний маршрут без ключа; фото —
// окремо: їх sha1-адреса сама є секретом-перепусткою)
if ($path === 'ping' && $method === 'GET') send_json(200, array('ok' => true, 'ts' => round(microtime(true) * 1000)));
if (!key_ok() && !(strpos($path, 'photo/') === 0 && $method === 'GET'))
    send_json(403, array('error' => 'потрібен ключ бригади', 'needKey' => true));

// GET /users — спільний список користувачів (PIN перевіряється на клієнті)
if ($path === 'users' && $method === 'GET') send_json(200, array('users' => load_users()));
// POST /users — оновити список; захист від випадкового стирання непорожнього
if ($path === 'users' && $method === 'POST') {
    $body = read_body();
    $incoming = (isset($body['users']) && is_array($body['users'])) ? $body['users'] : null;
    if ($incoming === null) send_json(400, array('error' => 'очікується { users: [...] }'));
    if (count($incoming) === 0 && count(load_users()) > 0)
        send_json(409, array('error' => 'відмова: спроба стерти всіх користувачів'));
    save_users($incoming);
    send_json(200, array('ok' => true, 'count' => count($incoming)));
}

// GET /base — довідник для завантаження робітником (без показань)
if ($path === 'base' && $method === 'GET') {
    $db = load_db();
    ensure_asg_stamps($db);
    send_json(200, array('hasBase' => count($db['houses']) > 0, 'houses' => $db['houses'],
        'boilers' => $db['boilers'], 'assignments' => assign_out($db['assignments']), 'assignmentsAt' => assign_out($db['assignmentsAt'] ?? array()),
        'contacts' => assign_out($db['contacts'] ?? array()),
        'routes' => assign_out($db['routes'] ?? array()),
        'baseSig' => $db['baseSig'], 'savedAt' => $db['savedAt']));
}
// POST /base — старший публікує довідник (показання й розподіл зберігаються)
if ($path === 'base' && $method === 'POST') {
    $body = read_body();
    if (empty($body['houses'])) send_json(400, array('error' => 'порожня база'));
    $db = load_db();
    $db['houses']  = $body['houses'];
    $db['boilers'] = $body['boilers'] ?? array();
    $db['baseSig'] = $body['baseSig'] ?? '';
    // Базові (архівні/імпортовані) показання — щоб робітник, який завантажить
    // базу, одразу бачив попередню історію споживання. Зливаємо у db.readings
    // (ідемпотентно: повторна публікація не дублює наявні показання).
    $baseAdded = 0;
    if (isset($body['readings']) && is_array($body['readings']) && count($body['readings']) > 0) {
        $st = merge_readings($db, $body['readings']);
        $baseAdded = $st['added'];
    }
    if (isset($body['contacts'])) merge_contacts($db, $body['contacts']);
    if (isset($body['routes'])) merge_routes($db, $body['routes']);
    $db['savedAt'] = round(microtime(true) * 1000);
    save_db($db);
    send_json(200, array('ok' => true, 'houses' => count($db['houses']), 'readings' => count($db['readings']), 'baseAdded' => $baseAdded,
        'contacts' => assign_out($db['contacts'] ?? array()), 'routes' => assign_out($db['routes'] ?? array())));
}
// POST /sync — push черги + опційно розподіл; повертає ЛИШЕ показання новіші за since
if ($path === 'sync' && $method === 'POST') {
    $body = read_body();
    $db = load_db();
    $warnBase = !empty($body['baseSig']) && !empty($db['baseSig']) && $body['baseSig'] !== $db['baseSig'];
    $stats = merge_readings($db, $body['readings'] ?? array());
    merge_assignments($db, $body['assignments'] ?? null, $body['assignmentsAt'] ?? null);
    // «закриття місяця» — бригадна мітка часу; перемагає новіша
    if (isset($body['closedAt'])) $db['closedAt'] = max((float)($db['closedAt'] ?? 0), (float)$body['closedAt']);
    // відкритий звітний період — бригадний; перемагає новіша мітка
    if (isset($body['periodAt']) && (float)$body['periodAt'] > (float)($db['periodAt'] ?? 0)
        && preg_match('/^\d{4}-\d{2}$/', (string)($body['periodKey'] ?? ''))) {
        $db['periodKey'] = (string)$body['periodKey']; $db['periodAt'] = (float)$body['periodAt'];
    }
    // ТУМБСТОУНИ видалення: злити мітки (новіша перемагає) і прибрати показання
    if (!isset($db['deletes']) || !is_array($db['deletes'])) $db['deletes'] = array();
    if (isset($body['deletes']) && is_array($body['deletes'])) {
        foreach ($body['deletes'] as $k => $at) { $at = (float)$at; if ($at > (float)($db['deletes'][$k] ?? 0)) $db['deletes'][$k] = $at; }
    }
    if (count($db['deletes'])) {
        $kept = array();
        foreach ($db['readings'] as $r) { $at = (float)($db['deletes'][key_of($r)] ?? 0); if (!($at && $at >= (float)($r['at'] ?? ($r['srvAt'] ?? 0)))) $kept[] = $r; }
        $db['readings'] = array_values($kept);
    }
    // заміни приладів — бригадні; на кожен ключ перемагає новіша мітка
    if (!isset($db['swaps']) || !is_array($db['swaps'])) $db['swaps'] = array();
    if (isset($body['swaps']) && is_array($body['swaps'])) {
        foreach ($body['swaps'] as $k => $inc) {
            if (!is_array($inc)) continue;
            $exAt = isset($db['swaps'][$k]['at']) ? (float)$db['swaps'][$k]['at'] : -1;
            if ((float)($inc['at'] ?? 0) > $exAt) $db['swaps'][$k] = $inc;
        }
    }
    if (isset($body['contacts'])) merge_contacts($db, $body['contacts']);
    if (isset($body['routes'])) merge_routes($db, $body['routes']);
    $db['savedAt'] = round(microtime(true) * 1000);
    save_db($db);
    $since = isset($body['since']) ? (float)$body['since'] : 0;
    if ($since > 0) {
        $out = array();
        foreach ($db['readings'] as $r) if (($r['srvAt'] ?? 0) > $since) $out[] = $r;
        $out = array_values($out);
    } else {
        $out = $db['readings'];
    }
    // keys — ПОВНИЙ набір ключів усіх показань на сервері (сервер = єдине джерело
    // правди). Клієнт звіряє свої польові показання: чого тут нема (видалили
    // будь-де) — прибирає й у себе. Легкий (лише ключі), тож іде щоразу навіть
    // при інкрементальному since; так видалення «зникає в усіх» без крихких
    // тумбстоунів на кожному пристрої.
    $keys = array();
    foreach ($db['readings'] as $r) $keys[] = key_of($r);
    send_json(200, array('ok' => true, 'warnBase' => (bool)$warnBase, 'stats' => $stats,
        'readings' => $out, 'keys' => $keys, 'maxSrvAt' => max_srv_at($db), 'assignments' => assign_out($db['assignments']), 'assignmentsAt' => assign_out($db['assignmentsAt'] ?? array()),
        'contacts' => assign_out($db['contacts'] ?? array()),
        'routes' => assign_out($db['routes'] ?? array()),
        'closedAt' => (float)($db['closedAt'] ?? 0),
        'periodKey' => (string)($db['periodKey'] ?? ''), 'periodAt' => (float)($db['periodAt'] ?? 0),
        'swaps' => assign_out($db['swaps'] ?? array()),
        'deletes' => assign_out($db['deletes'] ?? array()),
        'baseSig' => $db['baseSig'], 'hasBase' => count($db['houses']) > 0));
}

// GET /photo/<id> — віддати винесене фото
if (strpos($path, 'photo/') === 0 && $method === 'GET') {
    $id = substr($path, strlen('photo/'));
    if (!preg_match('/^p_[a-f0-9]{40}$/', $id)) { http_response_code(400); exit; }
    $file = $PHOTOS_DIR . '/' . $id . '.jpg';
    if (!is_file($file)) { http_response_code(404); exit; }
    header('Content-Type: image/jpeg');
    header('Cache-Control: private, max-age=31536000, immutable'); // вміст-адресоване — незмінне
    readfile($file);
    exit;
}

// GET /ocr — чи налаштоване розпізнавання (клієнт показує кнопку лише якщо так)
if ($path === 'ocr' && $method === 'GET') {
    $c = ocr_config();
    send_json(200, array('configured' => $c['key'] !== '', 'model' => $c['model']));
}
// POST /ocr — розпізнати показник з фото й повернути число (для звірки старшим)
if ($path === 'ocr' && $method === 'POST') {
    $c = ocr_config();
    if ($c['key'] === '') send_json(501, array('error' => 'OCR не налаштовано: додайте ключ у arm-data/config.json ({"anthropicKey":"sk-..."})'));
    if (!function_exists('curl_init')) send_json(501, array('error' => 'на сервері немає розширення PHP cURL'));
    $body = read_body();
    $b64 = null;
    if (!empty($body['dataUrl']) && strpos($body['dataUrl'], 'data:') === 0) {
        $comma = strpos($body['dataUrl'], ','); $b64 = $comma === false ? null : substr($body['dataUrl'], $comma + 1);
    } elseif (!empty($body['id'])) {
        $id = preg_replace('/^srv:/', '', $body['id']);
        if (!preg_match('/^p_[a-f0-9]{40}$/', $id)) send_json(400, array('error' => 'некоректний id фото'));
        $f = $PHOTOS_DIR . '/' . $id . '.jpg';
        if (!is_file($f)) send_json(404, array('error' => 'фото не знайдено на сервері'));
        $b64 = base64_encode(file_get_contents($f));
    }
    if (!$b64) send_json(400, array('error' => 'немає фото для розпізнавання'));
    $payload = json_encode(array(
        'model' => $c['model'], 'max_tokens' => 64,
        'messages' => array(array('role' => 'user', 'content' => array(
            array('type' => 'image', 'source' => array('type' => 'base64', 'media_type' => 'image/jpeg', 'data' => $b64)),
            array('type' => 'text', 'text' => OCR_PROMPT),
        ))),
    ), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $ch = curl_init($c['base'] . '/v1/messages');
    curl_setopt_array($ch, array(
        CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 45,
        CURLOPT_HTTPHEADER => array('x-api-key: ' . $c['key'], 'anthropic-version: 2023-06-01', 'content-type: application/json'),
        CURLOPT_POSTFIELDS => $payload,
    ));
    $resp = curl_exec($ch); $code = curl_getinfo($ch, CURLINFO_HTTP_CODE); $cerr = curl_error($ch); curl_close($ch);
    if ($resp === false) send_json(502, array('error' => 'запит до моделі не вдався: ' . $cerr));
    $j = json_decode($resp, true);
    if ($code !== 200) { $msg = isset($j['error']['message']) ? $j['error']['message'] : ('HTTP ' . $code); send_json(502, array('error' => 'модель: ' . $msg)); }
    $text = '';
    if (isset($j['content']) && is_array($j['content'])) foreach ($j['content'] as $blk) if (($blk['type'] ?? '') === 'text') $text .= $blk['text'];
    send_json(200, array('value' => ocr_parse_number($text), 'raw' => trim($text), 'model' => $c['model']));
}

send_json(404, array('error' => 'невідомий маршрут'));
