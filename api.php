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

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') { http_response_code(204); exit; }

$DATA_DIR   = __DIR__ . '/arm-data';
$DB_FILE    = $DATA_DIR . '/db.json';
$USERS_FILE = $DATA_DIR . '/users.json';

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
                 'assignments' => new stdClass(), 'baseSig' => '', 'savedAt' => 0);
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
    return $d;
}
function save_db($db) {
    global $DATA_DIR, $DB_FILE;
    if (!is_dir($DATA_DIR)) @mkdir($DATA_DIR, 0775, true);
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
    if (!is_dir($DATA_DIR)) @mkdir($DATA_DIR, 0775, true);
    $tmp = $USERS_FILE . '.tmp';
    file_put_contents($tmp, json_encode(array('version' => 1, 'users' => $users),
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT), LOCK_EX);
    @rename($tmp, $USERS_FILE);
}

// ---------- зведення показань (дзеркалить server.js / клієнтський _mergeReadings) ----------
function norm_s($s) { return strtolower(trim((string)($s === null ? '' : $s))); }
function key_of($r) {
    $ctrl = !empty($r['isControl']) ? 'k' : '';
    return norm_s($r['account'] ?? '') . '|' . ($r['date'] ?? '') . '|' . $ctrl;
}
function merge_readings(&$db, $incoming) {
    $now = round(microtime(true) * 1000); // мс, як Date.now()
    $index = array();
    foreach ($db['readings'] as $i => $r) $index[key_of($r)] = $i;
    $added = 0; $updated = 0; $conflicts = 0; $skipped = 0;
    foreach (($incoming ?: array()) as $inc) {
        if (!is_array($inc) || empty($inc['account'])) { $skipped++; continue; }
        $rec = $inc;
        unset($rec['houseId']); unset($rec['srvAt']);
        $rec['synced'] = true;
        $k = key_of($rec);
        if (!isset($index[$k])) {
            $rec['srvAt'] = $now;
            $db['readings'][] = $rec;
            $index[$k] = count($db['readings']) - 1;
            $added++;
        } else {
            $ex =& $db['readings'][$index[$k]];
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
// assignments має завжди серіалізуватись як об'єкт (не порожній масив)
function assign_out($a) {
    if (is_array($a) && count($a) === 0) return new stdClass();
    return $a;
}

// ---------- обробка ----------
$path   = route();
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// GET /ping — перевірка наявності сервера
if ($path === 'ping' && $method === 'GET') send_json(200, array('ok' => true, 'ts' => round(microtime(true) * 1000)));

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
    send_json(200, array('hasBase' => count($db['houses']) > 0, 'houses' => $db['houses'],
        'boilers' => $db['boilers'], 'assignments' => assign_out($db['assignments']),
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
    $db['savedAt'] = round(microtime(true) * 1000);
    save_db($db);
    send_json(200, array('ok' => true, 'houses' => count($db['houses']), 'readings' => count($db['readings'])));
}
// POST /sync — push черги + опційно розподіл; повертає ЛИШЕ показання новіші за since
if ($path === 'sync' && $method === 'POST') {
    $body = read_body();
    $db = load_db();
    $warnBase = !empty($body['baseSig']) && !empty($db['baseSig']) && $body['baseSig'] !== $db['baseSig'];
    $stats = merge_readings($db, $body['readings'] ?? array());
    if (isset($body['assignments']) && is_array($body['assignments'])) $db['assignments'] = $body['assignments'];
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
    send_json(200, array('ok' => true, 'warnBase' => (bool)$warnBase, 'stats' => $stats,
        'readings' => $out, 'maxSrvAt' => max_srv_at($db), 'assignments' => assign_out($db['assignments']),
        'baseSig' => $db['baseSig'], 'hasBase' => count($db['houses']) > 0));
}

send_json(404, array('error' => 'невідомий маршрут'));
