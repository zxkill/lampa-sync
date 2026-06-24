<?php
/**
 * Общая точка загрузки конфигурации.
 *
 * Файл подключается из api.php, progress.php и prepare_worker.php.
 * Он сначала ищет локальный config.php, а если его нет — использует config.example.php.
 * В публичном репозитории не должно быть настоящих доменов, паролей и абсолютных путей сервера.
 */
declare(strict_types=1);

if (!defined('LAMPA_SYNC_BOOTSTRAP')) {
    define('LAMPA_SYNC_BOOTSTRAP', true);
}

// Пути к локальному конфигу и примеру настроек.
$configFile = __DIR__ . '/config.php';
$exampleFile = __DIR__ . '/config.example.php';

if (is_file($configFile)) {
    require_once $configFile;
} elseif (is_file($exampleFile)) {
    require_once $exampleFile;
}


// Значения ниже — безопасные fallback-настройки на случай, если config.php ещё не создан.
if (!defined('BASE_PUBLIC_URL')) {
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? 'example.com';
    $script = $_SERVER['SCRIPT_NAME'] ?? '/lampa-sync/api.php';
    $dir = rtrim(str_replace('\\', '/', dirname($script)), '/');
    define('BASE_PUBLIC_URL', $scheme . '://' . $host . ($dir ?: '/'));
}
if (!defined('API_PUBLIC_URL')) define('API_PUBLIC_URL', rtrim(BASE_PUBLIC_URL, '/') . '/api.php');
if (!defined('QUEUE_PUBLIC_URL')) define('QUEUE_PUBLIC_URL', rtrim(BASE_PUBLIC_URL, '/') . '/prepare_queue.html');
if (!defined('TORRSERVER_LOCAL_BASE')) define('TORRSERVER_LOCAL_BASE', 'http://127.0.0.1:8090');
if (!defined('TORRSERVER_LOGIN')) define('TORRSERVER_LOGIN', '');
if (!defined('TORRSERVER_PASSWORD')) define('TORRSERVER_PASSWORD', '');
if (!defined('FFMPEG_BIN')) define('FFMPEG_BIN', 'ffmpeg');
if (!defined('FFPROBE_BIN')) define('FFPROBE_BIN', 'ffprobe');
if (!defined('LAMPA_SYNC_DATA_DIR')) define('LAMPA_SYNC_DATA_DIR', __DIR__ . '/data');
if (!defined('HLS_TTL')) define('HLS_TTL', 1800);
if (!defined('HLS_DONE_TTL')) define('HLS_DONE_TTL', 7200);
if (!defined('HLS_MAX_BYTES')) define('HLS_MAX_BYTES', 8000000000);
if (!defined('HLS_SEGMENT_SECONDS')) define('HLS_SEGMENT_SECONDS', 4);
if (!defined('WORKER_HEARTBEAT_STALE_MS')) define('WORKER_HEARTBEAT_STALE_MS', 10 * 60 * 1000);
if (!defined('FFMPEG_NO_PROGRESS_STALE_MS')) define('FFMPEG_NO_PROGRESS_STALE_MS', 15 * 60 * 1000);

/**
 * Собирает публичный URL до файла проекта с query-параметрами.
 */
function lampa_sync_public_url(string $path = '', array $query = []): string {
    $url = rtrim(BASE_PUBLIC_URL, '/') . '/' . ltrim($path, '/');
    if ($query) {
        $url .= (str_contains($url, '?') ? '&' : '?') . http_build_query($query, '', '&', PHP_QUERY_RFC3986);
    }
    return $url;
}

/**
 * Собирает URL до api.php с query-параметрами.
 */
function lampa_sync_api_url(array $query = []): string {
    $url = API_PUBLIC_URL;
    if ($query) {
        $url .= (str_contains($url, '?') ? '&' : '?') . http_build_query($query, '', '&', PHP_QUERY_RFC3986);
    }
    return $url;
}

/**
 * Формирует Basic Auth-заголовок для TorrServer, если логин и пароль заданы.
 */
function lampa_sync_auth_header(): string {
    $login = (string)TORRSERVER_LOGIN;
    $password = (string)TORRSERVER_PASSWORD;
    if ($login === '' && $password === '') return '';
    return 'Authorization: Basic ' . base64_encode($login . ':' . $password);
}

/**
 * Готовит HTTP-заголовки, которые ffmpeg/ffprobe передают при чтении потока TorrServer.
 */
function lampa_sync_ffmpeg_headers(): string {
    $headers = [];
    $auth = lampa_sync_auth_header();
    if ($auth !== '') $headers[] = $auth;
    $headers[] = 'User-Agent: Mozilla/5.0 LampaSync/1.0';
    return implode("\r\n", $headers) . "\r\n";
}
