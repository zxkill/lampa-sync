<?php
declare(strict_types=1);

/**
 * Lampa Sync API v8 (clean localStorage replication)
 *
 * Main endpoints:
 *   POST progress.php?user_id=...&profile=...&device_id=...
 *     Body: { "data": { "localStorage_key": "raw string" } }
 *     Server compares values and assigns server-side updated_at per changed key.
 *
 *   GET progress.php?user_id=...&profile=...&device_id=...&since=123&keys=k1,k2
 *     Returns only keys whose server updated_at is greater than `since`.
 *
 * Compatibility endpoints are also kept:
 *   GET ?meta=1
 *   GET ?keys=k1,k2
 */

error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('log_errors', '1');

require_once __DIR__ . '/bootstrap.php';

const API_VERSION = 'v8-clean-localstorage-sync';
const LOG_ENABLED = true;

// База синхронизации localStorage: прогресс, история, activity и связанные ключи Lampa.
$DATA_DIR = LAMPA_SYNC_DATA_DIR;
@mkdir($DATA_DIR, 0777, true);
ini_set('error_log', $DATA_DIR . '/error.log');

$DB_FILE = $DATA_DIR . '/progress.sqlite';
$SYNC_LOG_FILE = $DATA_DIR . '/sync.log';

headers_common();

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

try {
    $userId = only_digits((string)($_GET['user_id'] ?? ''), '');
    $profile = only_digits((string)($_GET['profile'] ?? '0'), '0');
    $deviceId = sanitize_device_id((string)($_GET['device_id'] ?? ''));

    if ($userId === '') {
        json_out(['ok' => false, 'error' => 'user_id required'], 400);
    }

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    if (!extension_loaded('pdo_sqlite')) {
        handle_json_backend($DATA_DIR . '/progress_store_v8.json', $DATA_DIR . '/progress_store_v8.lock', $userId, $profile, $deviceId, $method, $SYNC_LOG_FILE);
    }

    $pdo = storage_db($DB_FILE);

    if ($method === 'GET') {
        handle_get($pdo, $userId, $profile, $deviceId, $SYNC_LOG_FILE);
    }

    if ($method === 'POST') {
        handle_post($pdo, $userId, $profile, $deviceId, $SYNC_LOG_FILE);
    }

    json_out(['ok' => false, 'error' => 'Unsupported method'], 405);
} catch (Throwable $e) {
    sync_log($SYNC_LOG_FILE ?? (__DIR__ . '/data/sync.log'), 'error', [
        'message' => $e->getMessage(),
        'file' => basename($e->getFile()),
        'line' => $e->getLine(),
    ]);

    $out = ['ok' => false, 'error' => 'Storage failed'];

    if ((string)($_GET['debug'] ?? '') === '1') {
        $out['detail'] = $e->getMessage();
        $out['file'] = basename($e->getFile());
        $out['line'] = $e->getLine();
    }

    json_out($out, 500);
}

/**
 * Выставляет CORS и no-cache заголовки для sync API.
 */
function headers_common(): void {
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';

    if ($origin) {
        header('Access-Control-Allow-Origin: ' . $origin);
        header('Vary: Origin');
    } else {
        header('Access-Control-Allow-Origin: *');
    }

    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Access-Control-Max-Age: 86400');
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    header('Content-Type: application/json; charset=utf-8');
}

/**
 * Отдаёт JSON-ответ и завершает выполнение.
 */
function json_out(array $data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}


/**


 * Fallback-хранилище на JSON-файле, если pdo_sqlite недоступен.

 */


function handle_json_backend(string $storeFile, string $lockFile, string $userId, string $profile, string $deviceId, string $method, string $logFile): void {
    with_file_lock($lockFile, function () use ($storeFile, $userId, $profile, $deviceId, $method, $logFile): void {
        $store = read_json_store($storeFile);
        $scope =& json_scope($store, $userId, $profile);

        if ($method === 'GET') {
            if ((string)($_GET['debug'] ?? '') === '1') {
                json_out([
                    'ok' => true,
                    'api_version' => API_VERSION,
                    'backend' => 'json',
                    'db' => 'data/progress_store_v8.json',
                    'rows' => count($scope),
                ]);
            }

            if ((string)($_GET['inspect'] ?? '') === '1') {
                json_inspect_scope($scope, $userId, $profile);
            }

            $keys = parse_keys((string)($_GET['keys'] ?? ''));
            $since = to_int($_GET['since'] ?? null, -1);
            $rows = json_filter_rows($scope, $keys, $since >= 0 ? $since : 0, $since >= 0);

            if ((string)($_GET['meta'] ?? '') === '1') {
                [$meta, $origin] = json_rows_meta($rows);
                json_out([
                    'ok' => true,
                    'user' => $userId,
                    'profile' => $profile,
                    'cursor' => json_max_updated($scope, $keys),
                    'meta' => $meta,
                    'origin_device' => $origin,
                ]);
            }

            if ($since >= 0) {
                [$data, $meta, $origin] = json_rows_payload($rows);
                if ($rows) {
                    sync_log($logFile, 'pull', [
                        'backend' => 'json',
                        'user' => $userId,
                        'profile' => $profile,
                        'device' => $deviceId,
                        'since' => $since,
                        'count' => count($rows),
                        'keys' => array_keys($data),
                    ]);
                }
                json_out([
                    'ok' => true,
                    'user' => $userId,
                    'profile' => $profile,
                    'cursor' => json_max_updated($scope, $keys),
                    'changed' => $data,
                    'meta' => $meta,
                    'origin_device' => $origin,
                ]);
            }

            [$data, $meta, $origin] = json_rows_payload($rows);
            foreach ($keys as $key) {
                if (!array_key_exists($key, $data)) {
                    $data[$key] = '';
                    $meta[$key] = 0;
                    $origin[$key] = '';
                }
            }
            json_out([
                'ok' => true,
                'user' => $userId,
                'profile' => $profile,
                'cursor' => json_max_updated($scope, $keys),
                'data' => $data,
                'meta' => $meta,
                'origin_device' => $origin,
            ]);
        }

        if ($method === 'POST') {
            $raw = file_get_contents('php://input');
            $input = json_decode($raw ?: '', true);
            if (!is_array($input)) json_out(['ok' => false, 'error' => 'Invalid JSON'], 400);

            $incoming = isset($input['data']) && is_array($input['data']) ? $input['data'] : [];
            $saved = [];
            $skipped = [];
            $now = server_now_ms();
            $offset = 0;

            foreach ($incoming as $key => $value) {
                if (!is_string($key)) continue;
                $key = sanitize_key($key);
                if ($key === '') continue;

                $normalized = normalize_raw_value($value);
                if (is_bad_array_string($normalized)) {
                    $skipped[$key] = 'bad_array_string';
                    continue;
                }

                $existing = $scope[$key] ?? null;
                if (is_array($existing) && (string)($existing['raw_value'] ?? '') === $normalized) {
                    $saved[$key] = (int)($existing['updated_at'] ?? 0);
                    continue;
                }

                $ts = $now + (++$offset);
                $scope[$key] = [
                    'raw_value' => $normalized,
                    'updated_at' => $ts,
                    'created_at' => is_array($existing) ? (int)($existing['created_at'] ?? $ts) : $ts,
                    'origin_device' => $deviceId,
                ];
                $saved[$key] = $ts;
            }

            write_json_store($storeFile, $store);

            if ($saved) {
                sync_log($logFile, 'save', [
                    'backend' => 'json',
                    'user' => $userId,
                    'profile' => $profile,
                    'device' => $deviceId,
                    'count' => count($saved),
                    'keys' => array_keys($saved),
                ]);
            }

            json_out([
                'ok' => true,
                'user' => $userId,
                'profile' => $profile,
                'saved' => $saved,
                'skipped' => $skipped,
                'cursor' => max(array_merge([json_max_updated($scope, [])], array_values($saved))),
            ]);
        }

        json_out(['ok' => false, 'error' => 'Unsupported method'], 405);
    });
}

function &json_scope(array &$store, string $userId, string $profile): array {
    if (!isset($store[$userId]) || !is_array($store[$userId])) $store[$userId] = [];
    if (!isset($store[$userId][$profile]) || !is_array($store[$userId][$profile])) $store[$userId][$profile] = [];
    return $store[$userId][$profile];
}

/**
 * Фильтрует строки JSON-хранилища по ключам и since-cursor.
 */
function json_filter_rows(array $scope, array $keys, int $since, bool $deltaOnly): array {
    $out = [];
    $allowed = $keys ? array_fill_keys($keys, true) : null;

    foreach ($scope as $key => $row) {
        if ($allowed !== null && !isset($allowed[$key])) continue;
        if (!is_array($row)) continue;
        if ($deltaOnly && (int)($row['updated_at'] ?? 0) <= $since) continue;
        $out[] = ['storage_key' => $key] + $row;
    }

    usort($out, fn($a, $b) => ((int)($a['updated_at'] ?? 0)) <=> ((int)($b['updated_at'] ?? 0)));
    return $out;
}

/**
 * Собирает данные, метаданные и origin_device из JSON-строк.
 */
function json_rows_payload(array $rows): array {
    $data = [];
    $meta = [];
    $origin = [];

    foreach ($rows as $row) {
        $key = (string)$row['storage_key'];
        $value = (string)($row['raw_value'] ?? '');
        if ($value === 'Array') $value = '';
        $data[$key] = $value;
        $meta[$key] = (int)($row['updated_at'] ?? 0);
        $origin[$key] = (string)($row['origin_device'] ?? '');
    }

    return [$data, $meta, $origin];
}

/**
 * Собирает только updated_at/origin_device для meta-запросов.
 */
function json_rows_meta(array $rows): array {
    $meta = [];
    $origin = [];

    foreach ($rows as $row) {
        $key = (string)$row['storage_key'];
        $meta[$key] = (int)($row['updated_at'] ?? 0);
        $origin[$key] = (string)($row['origin_device'] ?? '');
    }

    return [$meta, $origin];
}

/**
 * Находит максимальный updated_at в JSON-области.
 */
function json_max_updated(array $scope, array $keys): int {
    $allowed = $keys ? array_fill_keys($keys, true) : null;
    $max = 0;

    foreach ($scope as $key => $row) {
        if ($allowed !== null && !isset($allowed[$key])) continue;
        if (is_array($row)) $max = max($max, (int)($row['updated_at'] ?? 0));
    }

    return $max;
}

/**
 * Диагностический вывод JSON-хранилища.
 */
function json_inspect_scope(array $scope, string $userId, string $profile): void {
    $limit = max(1, min(200, to_int($_GET['limit'] ?? 50, 50)));
    $items = [];

    foreach ($scope as $key => $row) {
        if (!is_array($row)) continue;
        $items[] = [
            'key' => (string)$key,
            'updated_at' => (int)($row['updated_at'] ?? 0),
            'origin_device' => (string)($row['origin_device'] ?? ''),
            'bytes' => strlen((string)($row['raw_value'] ?? '')),
        ];
    }

    usort($items, fn($a, $b) => $b['updated_at'] <=> $a['updated_at']);
    $items = array_slice($items, 0, $limit);

    json_out([
        'ok' => true,
        'api_version' => API_VERSION,
        'backend' => 'json',
        'user' => $userId,
        'profile' => $profile,
        'cursor' => json_max_updated($scope, []),
        'items' => $items,
    ]);
}

/**
 * Безопасно читает JSON-store с диска.
 */
function read_json_store(string $file): array {
    if (!is_file($file)) return [];
    $data = json_decode((string)file_get_contents($file), true);
    return is_array($data) ? $data : [];
}

/**
 * Пишет JSON-store атомарно через временный файл.
 */
function write_json_store(string $file, array $data): void {
    $tmp = $file . '.tmp';
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    if ($json === false) throw new RuntimeException('json_encode store failed');
    if (file_put_contents($tmp, $json, LOCK_EX) === false) throw new RuntimeException('write tmp failed');
    if (!rename($tmp, $file)) {
        @unlink($tmp);
        throw new RuntimeException('rename tmp failed');
    }
}

/**
 * Синхронизирует JSON fallback через файловую блокировку.
 */
function with_file_lock(string $lockFile, callable $fn): void {
    $fh = fopen($lockFile, 'c+');
    if ($fh === false) throw new RuntimeException('lock open failed');

    try {
        if (!flock($fh, LOCK_EX)) throw new RuntimeException('lock failed');
        $fn();
    } finally {
        @flock($fh, LOCK_UN);
        @fclose($fh);
    }
}

/**
 * Создаёт/мигрирует SQLite-таблицу sync_storage.
 */
function storage_db(string $dbFile): PDO {
    if (!extension_loaded('pdo_sqlite')) {
        throw new RuntimeException('pdo_sqlite not installed');
    }

    $dir = dirname($dbFile);

    if (!is_dir($dir)) {
        @mkdir($dir, 0777, true);
    }

    if (!is_writable($dir)) {
        throw new RuntimeException('data dir not writable: ' . $dir);
    }

    $pdo = new PDO('sqlite:' . $dbFile);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->exec('PRAGMA busy_timeout = 5000');

    try {
        $pdo->exec('PRAGMA journal_mode = WAL');
    } catch (Throwable $e) {
        error_log('WAL mode failed, continue without WAL: ' . $e->getMessage());
    }

    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS storage_sync (
            user_id TEXT NOT NULL,
            profile TEXT NOT NULL,
            storage_key TEXT NOT NULL,
            raw_value TEXT NOT NULL DEFAULT "",
            updated_at INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT 0,
            origin_device TEXT NOT NULL DEFAULT ""
        )'
    );

    ensure_column($pdo, 'storage_sync', 'user_id', 'TEXT NOT NULL DEFAULT "0"');
    ensure_column($pdo, 'storage_sync', 'profile', 'TEXT NOT NULL DEFAULT "0"');
    ensure_column($pdo, 'storage_sync', 'storage_key', 'TEXT NOT NULL DEFAULT ""');
    ensure_column($pdo, 'storage_sync', 'raw_value', 'TEXT NOT NULL DEFAULT ""');
    ensure_column($pdo, 'storage_sync', 'updated_at', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'storage_sync', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
    ensure_column($pdo, 'storage_sync', 'origin_device', 'TEXT NOT NULL DEFAULT ""');

    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_storage_sync_scope ON storage_sync(user_id, profile)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_storage_sync_delta ON storage_sync(user_id, profile, updated_at)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_storage_sync_key ON storage_sync(user_id, profile, storage_key)');

    return $pdo;
}

/**
 * Добавляет колонку в SQLite-таблицу, если её ещё нет.
 */
function ensure_column(PDO $pdo, string $table, string $column, string $definition): void {
    $st = $pdo->query('PRAGMA table_info(' . $table . ')');
    $columns = [];

    while ($row = $st->fetch(PDO::FETCH_ASSOC)) {
        $columns[(string)$row['name']] = true;
    }

    if (!isset($columns[$column])) {
        $pdo->exec('ALTER TABLE ' . $table . ' ADD COLUMN ' . $column . ' ' . $definition);
    }
}

/**
 * Обрабатывает GET-запросы синхронизации и отдаёт изменения.
 */
function handle_get(PDO $pdo, string $userId, string $profile, string $deviceId, string $logFile): void {
    if ((string)($_GET['debug'] ?? '') === '1') {
        $count = (int)$pdo->query('SELECT COUNT(*) FROM storage_sync')->fetchColumn();
        json_out([
            'ok' => true,
            'api_version' => API_VERSION,
            'backend' => 'sqlite',
            'db' => 'data/progress.sqlite',
            'rows' => $count,
        ]);
    }

    if ((string)($_GET['inspect'] ?? '') === '1') {
        inspect_scope($pdo, $userId, $profile);
    }

    $keys = parse_keys((string)($_GET['keys'] ?? ''));

    if ((string)($_GET['meta'] ?? '') === '1') {
        $rows = read_rows($pdo, $userId, $profile, $keys, 0, false);
        [$meta, $origin] = rows_meta($rows);

        json_out([
            'ok' => true,
            'user' => $userId,
            'profile' => $profile,
            'cursor' => max_updated_at($rows),
            'meta' => $meta,
            'origin_device' => $origin,
        ]);
    }

    $since = to_int($_GET['since'] ?? null, -1);

    if ($since >= 0) {
        $rows = read_rows($pdo, $userId, $profile, $keys, $since, true);
        [$data, $meta, $origin] = rows_payload($rows);
        $cursor = max_scope_updated_at($pdo, $userId, $profile, $keys);

        if ($rows) {
            sync_log($logFile, 'pull', [
                'user' => $userId,
                'profile' => $profile,
                'device' => $deviceId,
                'since' => $since,
                'count' => count($rows),
                'keys' => array_keys($data),
            ]);
        }

        json_out([
            'ok' => true,
            'user' => $userId,
            'profile' => $profile,
            'cursor' => $cursor,
            'changed' => $data,
            'meta' => $meta,
            'origin_device' => $origin,
        ]);
    }

    // Legacy full/key fetch.
    $rows = read_rows($pdo, $userId, $profile, $keys, 0, false);
    [$data, $meta, $origin] = rows_payload($rows);

    foreach ($keys as $key) {
        if (!array_key_exists($key, $data)) {
            $data[$key] = '';
            $meta[$key] = 0;
            $origin[$key] = '';
        }
    }

    json_out([
        'ok' => true,
        'user' => $userId,
        'profile' => $profile,
        'cursor' => max_updated_at($rows),
        'data' => $data,
        'meta' => $meta,
        'origin_device' => $origin,
    ]);
}

/**
 * Принимает изменённые localStorage-ключи и сохраняет их на сервере.
 */
function handle_post(PDO $pdo, string $userId, string $profile, string $deviceId, string $logFile): void {
    $raw = file_get_contents('php://input');
    $input = json_decode($raw ?: '', true);

    if (!is_array($input)) {
        json_out(['ok' => false, 'error' => 'Invalid JSON'], 400);
    }

    $incoming = isset($input['data']) && is_array($input['data']) ? $input['data'] : [];

    if (!$incoming) {
        json_out(['ok' => true, 'saved' => [], 'skipped' => [], 'cursor' => max_scope_updated_at($pdo, $userId, $profile, [])]);
    }

    $select = $pdo->prepare(
        'SELECT rowid, raw_value, updated_at
         FROM storage_sync
         WHERE user_id = :user AND profile = :profile AND storage_key = :key
         ORDER BY updated_at DESC, rowid DESC
         LIMIT 1'
    );

    $update = $pdo->prepare(
        'UPDATE storage_sync
         SET raw_value = :value, updated_at = :updated, origin_device = :origin
         WHERE rowid = :rowid'
    );

    $insert = $pdo->prepare(
        'INSERT INTO storage_sync (user_id, profile, storage_key, raw_value, updated_at, created_at, origin_device)
         VALUES (:user, :profile, :key, :value, :updated, :created, :origin)'
    );

    $saved = [];
    $skipped = [];
    $now = server_now_ms();
    $offset = 0;

    $pdo->beginTransaction();

    try {
        foreach ($incoming as $key => $value) {
            if (!is_string($key)) {
                continue;
            }

            $key = sanitize_key($key);

            if ($key === '') {
                continue;
            }

            $normalized = normalize_raw_value($value);

            if (is_bad_array_string($normalized)) {
                $skipped[$key] = 'bad_array_string';
                continue;
            }

            $select->execute([
                'user' => $userId,
                'profile' => $profile,
                'key' => $key,
            ]);

            $existing = $select->fetch(PDO::FETCH_ASSOC) ?: null;

            if ($existing && (string)$existing['raw_value'] === $normalized) {
                $saved[$key] = (int)$existing['updated_at'];
                continue;
            }

            $ts = $now + (++$offset);

            if ($existing) {
                $update->execute([
                    'value' => $normalized,
                    'updated' => $ts,
                    'origin' => $deviceId,
                    'rowid' => (int)$existing['rowid'],
                ]);
            } else {
                $insert->execute([
                    'user' => $userId,
                    'profile' => $profile,
                    'key' => $key,
                    'value' => $normalized,
                    'updated' => $ts,
                    'created' => $ts,
                    'origin' => $deviceId,
                ]);
            }

            $saved[$key] = $ts;
        }

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }

    if ($saved) {
        sync_log($logFile, 'save', [
            'user' => $userId,
            'profile' => $profile,
            'device' => $deviceId,
            'count' => count($saved),
            'keys' => array_keys($saved),
        ]);
    }

    json_out([
        'ok' => true,
        'user' => $userId,
        'profile' => $profile,
        'saved' => $saved,
        'skipped' => $skipped,
        'cursor' => max(array_merge([max_scope_updated_at($pdo, $userId, $profile, [])], array_values($saved))),
    ]);
}

/**
 * Читает строки SQLite по user/profile/keys/since.
 */
function read_rows(PDO $pdo, string $userId, string $profile, array $keys, int $since, bool $deltaOnly): array {
    $params = [':user' => $userId, ':profile' => $profile];
    $where = 'user_id = :user AND profile = :profile';

    if ($deltaOnly) {
        $where .= ' AND updated_at > :since';
        $params[':since'] = $since;
    }

    if ($keys) {
        $placeholders = [];
        foreach ($keys as $i => $key) {
            $ph = ':key' . $i;
            $placeholders[] = $ph;
            $params[$ph] = $key;
        }
        $where .= ' AND storage_key IN (' . implode(',', $placeholders) . ')';
    }

    $sql = 'SELECT storage_key, raw_value, updated_at, origin_device
            FROM storage_sync
            WHERE ' . $where . '
            ORDER BY updated_at ASC';

    $st = $pdo->prepare($sql);
    $st->execute($params);

    $out = [];

    while ($row = $st->fetch(PDO::FETCH_ASSOC)) {
        $key = (string)$row['storage_key'];
        // If an old table accidentally contains duplicates, keep newest by key.
        if (!isset($out[$key]) || (int)$row['updated_at'] >= (int)$out[$key]['updated_at']) {
            $out[$key] = $row;
        }
    }

    return array_values($out);
}

/**
 * Преобразует строки SQLite в data/meta/origin_device.
 */
function rows_payload(array $rows): array {
    $data = [];
    $meta = [];
    $origin = [];

    foreach ($rows as $row) {
        $key = (string)$row['storage_key'];
        $value = (string)$row['raw_value'];

        if ($value === 'Array') {
            $value = '';
        }

        $data[$key] = $value;
        $meta[$key] = (int)$row['updated_at'];
        $origin[$key] = (string)($row['origin_device'] ?? '');
    }

    return [$data, $meta, $origin];
}

/**
 * Возвращает только метаданные строк SQLite.
 */
function rows_meta(array $rows): array {
    $meta = [];
    $origin = [];

    foreach ($rows as $row) {
        $key = (string)$row['storage_key'];
        $meta[$key] = (int)$row['updated_at'];
        $origin[$key] = (string)($row['origin_device'] ?? '');
    }

    return [$meta, $origin];
}

/**
 * Находит максимальный updated_at для указанной области sync_storage.
 */
function max_scope_updated_at(PDO $pdo, string $userId, string $profile, array $keys): int {
    $params = [':user' => $userId, ':profile' => $profile];
    $where = 'user_id = :user AND profile = :profile';

    if ($keys) {
        $placeholders = [];
        foreach ($keys as $i => $key) {
            $ph = ':key' . $i;
            $placeholders[] = $ph;
            $params[$ph] = $key;
        }
        $where .= ' AND storage_key IN (' . implode(',', $placeholders) . ')';
    }

    $st = $pdo->prepare('SELECT MAX(updated_at) FROM storage_sync WHERE ' . $where);
    $st->execute($params);

    return (int)($st->fetchColumn() ?: 0);
}

/**
 * Находит максимальный updated_at среди уже прочитанных строк.
 */
function max_updated_at(array $rows): int {
    $max = 0;

    foreach ($rows as $row) {
        $max = max($max, (int)($row['updated_at'] ?? 0));
    }

    return $max;
}

/**
 * Диагностический вывод содержимого области sync_storage.
 */
function inspect_scope(PDO $pdo, string $userId, string $profile): void {
    $limit = max(1, min(200, to_int($_GET['limit'] ?? 50, 50)));

    $st = $pdo->prepare(
        'SELECT storage_key, updated_at, origin_device, length(raw_value) AS bytes
         FROM storage_sync
         WHERE user_id = :user AND profile = :profile
         ORDER BY updated_at DESC
         LIMIT ' . $limit
    );
    $st->execute(['user' => $userId, 'profile' => $profile]);

    $rows = [];
    while ($row = $st->fetch(PDO::FETCH_ASSOC)) {
        $rows[] = [
            'key' => (string)$row['storage_key'],
            'updated_at' => (int)$row['updated_at'],
            'origin_device' => (string)($row['origin_device'] ?? ''),
            'bytes' => (int)($row['bytes'] ?? 0),
        ];
    }

    json_out([
        'ok' => true,
        'api_version' => API_VERSION,
        'user' => $userId,
        'profile' => $profile,
        'cursor' => max_scope_updated_at($pdo, $userId, $profile, []),
        'items' => $rows,
    ]);
}

/**
 * Разбирает список ключей localStorage из параметра keys.
 */
function parse_keys(string $raw): array {
    if ($raw === '') {
        return [];
    }

    $out = [];
    foreach (explode(',', $raw) as $key) {
        $key = sanitize_key($key);
        if ($key !== '') {
            $out[$key] = true;
        }
    }

    return array_keys($out);
}

/**
 * Оставляет только цифры в user/profile id.
 */
function only_digits(string $s, string $fallback = '0'): string {
    $s = preg_replace('/\D+/', '', $s);
    if ($s === null || $s === '') return $fallback;
    return $s;
}

/**
 * Фильтрует имя localStorage-ключа перед сохранением.
 */
function sanitize_key(string $key): string {
    $key = trim($key);
    $key = preg_replace('/[^a-zA-Z0-9_\-:.]/', '', $key);
    return $key ?? '';
}

/**
 * Фильтрует device_id клиента.
 */
function sanitize_device_id(string $v): string {
    $v = trim($v);
    $v = preg_replace('/[^a-zA-Z0-9_\-:.]/', '', $v);
    if ($v === null) return '';
    return substr($v, 0, 128);
}

/**
 * Безопасно приводит значение к int.
 */
function to_int($value, int $default = 0): int {
    if (is_int($value)) return $value;
    if (is_float($value)) return (int)$value;
    if (is_string($value) && $value !== '' && is_numeric($value)) return (int)$value;
    return $default;
}

/**
 * Серверное время в миллисекундах.
 */
function server_now_ms(): int {
    return (int)floor(microtime(true) * 1000);
}

/**
 * Отсекает повреждённое значение Array из старых версий/ошибок PHP.
 */
function is_bad_array_string($value): bool {
    return is_string($value) && $value === 'Array';
}

/**
 * Приводит значение localStorage к строковому формату.
 */
function normalize_raw_value($value): string {
    if (is_string($value)) return $value;
    if ($value === null) return '';

    $json = json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    return is_string($json) ? $json : '';
}

/**
 * Пишет краткий лог синхронизации в data/sync.log.
 */
function sync_log(string $file, string $event, array $data): void {
    if (!LOG_ENABLED) return;

    $safe = [
        'time' => date('c'),
        'event' => $event,
        'data' => $data,
    ];

    $line = json_encode($safe, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($line === false) return;

    @file_put_contents($file, $line . PHP_EOL, FILE_APPEND | LOCK_EX);
}
