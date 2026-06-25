<?php

declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('log_errors', '1');

// Подключаем локальные настройки: домен, TorrServer, пути к ffmpeg и рабочую директорию.
require_once __DIR__ . '/bootstrap.php';

if (!defined('API_VERSION')) define('API_VERSION', 'v1.0.9-ultra-quality-preset');


// Основные рабочие директории и SQLite-база очереди подготовки.
$DATA_DIR = LAMPA_SYNC_DATA_DIR;
$HLS_DIR = $DATA_DIR . '/hls';
$PREPARED_DIR = $DATA_DIR . '/prepared';
$PREPARE_DB = $DATA_DIR . '/prepare_queue.sqlite';
@mkdir($DATA_DIR, 0777, true);
@mkdir($HLS_DIR, 0777, true);
@mkdir($PREPARED_DIR, 0777, true);
ini_set('error_log', $DATA_DIR . '/error.log');


// Единая точка входа API: маршрутизация идёт по query-параметрам.
headers_common();
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') exit;

try {
    cleanup_hls($HLS_DIR, false);
    /*
     * Важно: специальные debug-запросы должны обрабатываться раньше общего debug=1.
     * Например, subtitle_vtt=1&debug=1 должен попасть в отладку субтитров,
     * а не в общий диагностический вывод api.php?debug=1.
     */
    if (g('subtitle_vtt') === '1') subtitle_vtt_endpoint($HLS_DIR);
    if (g('media_info') === '1') media_info_endpoint($HLS_DIR);
    if (g('debug') === '1') debug($DATA_DIR, $HLS_DIR);
    if (g('prepared_hls') === '1') serve_prepared_hls($PREPARED_DIR);
    if (g('prepare_worker_debug') === '1') prepare_worker_debug($PREPARE_DB, $PREPARED_DIR);
    if (g('prepare_inspect') === '1') prepare_inspect($PREPARE_DB, $PREPARED_DIR);
    if (g('prepare_kick') === '1') { $spawn = spawn_prepare_worker(); json(['ok'=>(bool)($spawn['ok'] ?? false), 'spawn'=>$spawn]); }
    if (g('prepare_reset_stalled') === '1') prepare_reset_stalled($PREPARE_DB, $PREPARED_DIR);
    if (g('prepare_retry') === '1') prepare_retry($PREPARE_DB, $PREPARED_DIR);
    if (g('prepare_start') === '1') prepare_start($PREPARE_DB, $PREPARED_DIR);
    if (g('prepare_status') === '1') prepare_status($PREPARE_DB, $PREPARED_DIR);
    if (g('prepare_delete') === '1') prepare_delete($PREPARE_DB, $PREPARED_DIR);
    if (g('prepare_list') === '1') prepare_list($PREPARE_DB, $PREPARED_DIR);
    if (g('cleanup') === '1') { cleanup_hls($HLS_DIR, true); json(['ok'=>true]); }
    if (g('debug_stream') === '1') debug_stream();
    if (g('proxy') === '1') proxy_stream();
    if (g('hls') === '1') serve_hls($HLS_DIR);
    if (isset($_GET['transcode_stop']) || isset($_GET['stop_hls']) || isset($_GET['hls_stop'])) stop_hls($HLS_DIR);
    if (isset($_GET['transcode_touch']) || isset($_GET['hls_touch'])) { $sid = sid(g('sid')); touch_session(session_dir($HLS_DIR,$sid)); json(['ok'=>true,'sid'=>$sid]); }
    if (isset($_GET['transcode_status']) || isset($_GET['hls_status']) || isset($_GET['status'])) hls_status($HLS_DIR);
    if (isset($_GET['transcode_start']) || isset($_GET['hls_start']) || isset($_GET['start_hls']) || isset($_GET['transcode'])) start_hls($HLS_DIR);
    progress_api($DATA_DIR);
} catch (Throwable $e) {
    error_log($e->getMessage() . "\n" . $e->getTraceAsString());
    json(['ok'=>false,'error'=>$e->getMessage(),'file'=>basename($e->getFile()),'line'=>$e->getLine()], 500);
}

/**
 * Выставляет CORS, Range и служебные заголовки для API, HLS и прокси-потока.
 */
function headers_common(): void {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Range');
    header('Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, Content-Type');
    header('X-Accel-Buffering: no');
}
/**
 * Безопасно читает строковый GET-параметр.
 */
function g(string $k, string $d=''): string { return isset($_GET[$k]) ? trim((string)$_GET[$k]) : $d; }
/**
 * Лениво читает JSON-тело запроса для POST/PUT-like API-команд.
 */
function body_json(): array {
    static $data = null;
    if ($data !== null) return $data;
    $raw = (string)file_get_contents('php://input');
    $parsed = json_decode($raw !== '' ? $raw : '{}', true);
    $data = is_array($parsed) ? $parsed : [];
    return $data;
}
/**
 * Читает параметр из GET, POST или JSON-тела.
 */
function req(string $k, string $d=''): string {
    if (isset($_GET[$k])) return trim((string)$_GET[$k]);
    if (isset($_POST[$k])) return trim((string)$_POST[$k]);
    $body = body_json();
    if (array_key_exists($k, $body)) return trim((string)$body[$k]);
    return $d;
}
/**
 * Отдаёт JSON-ответ и завершает выполнение скрипта.
 */
function json($data, int $code=200): void { http_response_code($code); header('Content-Type: application/json; charset=utf-8'); echo json_encode($data, JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES); exit; }
/**
 * Приводит произвольную строку к безопасному имени директории/сессии.
 */
function sid(string $v): string { $v=trim($v); if($v==='') return ''; $s=preg_replace('~[^a-zA-Z0-9_-]+~','_',$v); $s=trim((string)$s,'_'); return substr($s ?: ('s_'.substr(sha1($v),0,16)),0,96); }
/**
 * Возвращает путь к директории HLS-сессии по её идентификатору.
 */
function session_dir(string $root,string $sid): string { return rtrim($root,'/').'/'.sid($sid); }
/**
 * Прокидывает Basic Auth TorrServer из общего bootstrap/config.
 */
function auth_header(): string { return lampa_sync_auth_header(); }
/**
 * Создаёт директорию, если она ещё не существует.
 */
function ensure_dir(string $d): void { if(!is_dir($d)) @mkdir($d,0777,true); }
/**
 * Читает хвост лог-файла без загрузки всего файла в память.
 */
function tail_file(string $f,int $n=4000): string { if(!is_file($f)) return ''; $s=filesize($f); if(!$s) return ''; $fp=fopen($f,'rb'); if(!$fp) return ''; if($s>$n) fseek($fp,-$n,SEEK_END); $r=(string)stream_get_contents($fp); fclose($fp); return $r; }
/**
 * Рекурсивно удаляет директорию с HLS-сегментами или подготовкой.
 */
function rrmdir(string $d): void { if(!is_dir($d)) return; foreach(scandir($d)?:[] as $i){ if($i==='.'||$i==='..') continue; $p="$d/$i"; is_dir($p)?rrmdir($p):@unlink($p);} @rmdir($d); }
/**
 * Считает размер директории рекурсивно.
 */
function dsize(string $d): int { if(!is_dir($d)) return 0; $n=0; foreach(scandir($d)?:[] as $i){ if($i==='.'||$i==='..') continue; $p="$d/$i"; $n += is_dir($p)?dsize($p):(is_file($p)?(int)filesize($p):0);} return $n; }
/**
 * Проверяет, жив ли процесс по PID.
 */
function running(int $pid): bool { if($pid<=0) return false; if(function_exists('posix_kill')) return @posix_kill($pid,0); $c=1; @exec('kill -0 '.(int)$pid.' 2>/dev/null', $_, $c); return $c===0; }
/**
 * Мягко завершает процесс, а затем принудительно убивает его при необходимости.
 */
function kill_pid(int $pid): void { if($pid<=0) return; @exec('kill -TERM '.(int)$pid.' 2>/dev/null'); usleep(400000); if(running($pid)) @exec('kill -KILL '.(int)$pid.' 2>/dev/null'); }
/**
 * Читает JSON-файл в массив, возвращая пустой массив при ошибке.
 */
function read_json(string $f): array { if(!is_file($f)) return []; $x=json_decode((string)file_get_contents($f),true); return is_array($x)?$x:[]; }
/**
 * Записывает массив в JSON-файл в читаемом виде.
 */
function write_json(string $f,array $d): void { file_put_contents($f,json_encode($d,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_PRETTY_PRINT)); }
/**
 * Обновляет отметку активности HLS-сессии.
 */
function touch_session(string $d): void { if(is_dir($d)) @touch($d.'/last_touch.txt'); }

/**
 * Определяет, похож ли URL на поток TorrServer.
 */
function is_torr(string $url): bool { $p=parse_url($url); if(!$p) return false; $h=strtolower($p['host']??''); $port=(int)($p['port']??0); $path=strtolower($p['path']??''); return $port===8090 || $h==='localhost' || $h==='127.0.0.1' || str_contains($path,'/stream/'); }
/**
 * Удаляет runtime-параметры Lampa/TorrServer, чтобы поток стартовал в нужном режиме.
 */
function clean_query(string $q, string $mode='playback'): string {
    /*
     * TorrServer/Lampa links may contain runtime flags such as fromlast/preload.
     * For background preparation we must never continue the current playback
     * position: worker has to open a new HTTP consumer from byte/time zero.
     */
    $rm = [
        'preload'=>1,
        'stat'=>1,
        'm3u'=>1,
        'fromlast'=>1,
        'save'=>1,
        'play'=>1,
        'start'=>1,
        'time'=>1,
        'position'=>1,
        'pos'=>1,
        'seek'=>1,
        't'=>1,
    ];
    $out=[];
    foreach(($q===''?[]:explode('&',$q)) as $part){
        if($part==='') continue;
        $key=strtolower(rawurldecode(explode('=',$part,2)[0]));
        $key=rtrim($key,'.');
        if(isset($rm[$key])) continue;
        $out[]=$part;
    }
    $out[]='play';
    return implode('&',$out);
}
/**
 * Нормализует TorrServer URL для обычного онлайн-просмотра.
 */
function norm_url(string $url): string { $p=parse_url($url); if(!$p || empty($p['path']) || !is_torr($url)) return $url; $q=clean_query($p['query']??'', 'playback'); return rtrim(TORRSERVER_LOCAL_BASE,'/').$p['path'].($q!==''?'?'.$q:''); }
/**
 * Нормализует TorrServer URL для фоновой подготовки строго с начала файла.
 */
function norm_prepare_url(string $url): string { $p=parse_url($url); if(!$p || empty($p['path']) || !is_torr($url)) return $url; $q=clean_query($p['query']??'', 'prepare'); return rtrim(TORRSERVER_LOCAL_BASE,'/').$p['path'].($q!==''?'?'.$q:''); }
/**
 * Проверяет, есть ли в ссылке параметры продолжения/перемотки.
 */
function url_query_has_runtime_seek(string $url): bool { $q=(string)(parse_url($url, PHP_URL_QUERY) ?: ''); if($q==='') return false; foreach(explode('&',$q) as $part){ $key=strtolower(rawurldecode(explode('=',$part,2)[0])); $key=rtrim($key,'.'); if(in_array($key,['fromlast','start','time','position','pos','seek'],true)) return true; } return false; }

/**
 * Достаёт исходный stream URL, если пользователь вставил ссылку на player.html или proxy.
 */
function extract_prepare_source_url(string $input): string {
    $input = trim($input);
    if ($input === '') return '';

    // If user pasted our player/proxy URL, extract the nested source stream URL.
    $query = (string)(parse_url($input, PHP_URL_QUERY) ?: '');
    if ($query !== '') {
        parse_str($query, $params);
        foreach (['url', 'stream_url', 'src', 'source'] as $k) {
            if (!empty($params[$k]) && is_string($params[$k]) && preg_match('#^https?://#i', $params[$k])) {
                return trim($params[$k]);
            }
        }
    }

    return $input;
}
/**
 * Пытается получить читаемое название фильма/серии из имени файла в URL.
 */
function prepare_title_from_url(string $url): string {
    $path = (string)(parse_url($url, PHP_URL_PATH) ?: '');
    $base = rawurldecode(basename($path));
    $base = preg_replace('~\.(mkv|mp4|avi|mov|webm|m4v|ts)$~i', '', $base ?: '');
    $base = str_replace(['.', '_'], ' ', (string)$base);
    $base = preg_replace('~\s+~', ' ', (string)$base);
    return trim((string)$base);
}



/**



 * Создаёт стабильный ключ директории prepared/ для конкретной задачи.


 */



function prepare_key(string $contentId, string $url=''): string {
    $base = $contentId !== '' ? $contentId : $url;
    return sid('p_' . substr(sha1($base), 0, 24));
}

/**
 * Возвращает текущее время в миллисекундах для статусов и heartbeat.
 */
function prepare_now_ms(): int {
    return (int)round(microtime(true) * 1000);
}

/**
 * Создаёт/мигрирует SQLite-таблицу очереди подготовки.
 */
function prepare_db(string $dbFile): PDO {
    if (!extension_loaded('pdo_sqlite')) json(['ok'=>false,'error'=>'pdo_sqlite required for prepare queue'],500);
    ensure_dir(dirname($dbFile));
    $pdo = new PDO('sqlite:' . $dbFile);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA busy_timeout = 5000');
    $pdo->exec('CREATE TABLE IF NOT EXISTS prepare_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_id TEXT NOT NULL UNIQUE,
        prepare_key TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL DEFAULT \'\',
        source_url TEXT NOT NULL,
        normalized_url TEXT NOT NULL,
        quality TEXT NOT NULL DEFAULT \'fast\',
        status TEXT NOT NULL DEFAULT \'queued\',
        progress REAL NOT NULL DEFAULT 0,
        duration REAL NOT NULL DEFAULT 0,
        prepared_seconds REAL NOT NULL DEFAULT 0,
        segments INTEGER NOT NULL DEFAULT 0,
        pid INTEGER NOT NULL DEFAULT 0,
        worker_pid INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        next_retry_at INTEGER NOT NULL DEFAULT 0,
        last_heartbeat_at INTEGER NOT NULL DEFAULT 0,
        last_progress_at INTEGER NOT NULL DEFAULT 0,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT \'\',
        hls_url TEXT NOT NULL DEFAULT \'\',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER NOT NULL DEFAULT 0,
        finished_at INTEGER NOT NULL DEFAULT 0
    )');

    $cols = [];
    foreach ($pdo->query('PRAGMA table_info(prepare_queue)')->fetchAll(PDO::FETCH_ASSOC) ?: [] as $col) {
        $cols[(string)$col['name']] = true;
    }
    $add = [
        'worker_pid' => 'INTEGER NOT NULL DEFAULT 0',
        'attempts' => 'INTEGER NOT NULL DEFAULT 0',
        'max_attempts' => 'INTEGER NOT NULL DEFAULT 3',
        'next_retry_at' => 'INTEGER NOT NULL DEFAULT 0',
        'last_heartbeat_at' => 'INTEGER NOT NULL DEFAULT 0',
        'last_progress_at' => 'INTEGER NOT NULL DEFAULT 0',
        'cancel_requested' => 'INTEGER NOT NULL DEFAULT 0',
        'torrent_hash' => "TEXT NOT NULL DEFAULT ''",
        'file_index' => 'INTEGER NOT NULL DEFAULT -1',
        'stream_path' => "TEXT NOT NULL DEFAULT ''",
        'audio_track' => 'INTEGER NOT NULL DEFAULT 0',
    ];
    foreach ($add as $name => $sql) {
        if (!isset($cols[$name])) {
            $pdo->exec('ALTER TABLE prepare_queue ADD COLUMN ' . $name . ' ' . $sql);
        }
    }
    $pdo->exec('CREATE INDEX IF NOT EXISTS ix_prepare_queue_status ON prepare_queue(status, updated_at)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS ix_prepare_queue_retry ON prepare_queue(status, next_retry_at)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS ix_prepare_queue_torrent ON prepare_queue(torrent_hash, file_index, audio_track)');
    return $pdo;
}


/**


 * Строит публичный URL готового HLS-плейлиста.

 */


function prepare_public_hls_url(string $key): string {
    return lampa_sync_api_url(['prepared_hls'=>'1', 'key'=>$key, 'file'=>'index.m3u8']);
}

/**
 * Преобразует строку БД очереди в JSON для API и страницы очереди.
 */
function prepare_row_out(array $r, string $preparedRoot): array {
    $key = (string)($r['prepare_key'] ?? '');
    $identity = prepare_torrent_identity((string)($r['normalized_url'] ?? ($r['source_url'] ?? '')));
    $torrentHash = (string)($r['torrent_hash'] ?? '');
    if ($torrentHash === '') $torrentHash = $identity['torrent_hash'];
    $fileIndex = (int)($r['file_index'] ?? -1);
    if ($fileIndex < 0) $fileIndex = (int)$identity['file_index'];
    $streamPath = (string)($r['stream_path'] ?? '');
    if ($streamPath === '') $streamPath = $identity['stream_path'];
    $dir = session_dir($preparedRoot, $key);
    $segments = is_dir($dir) ? (count(glob("$dir/*.m4s") ?: []) + count(glob("$dir/*.ts") ?: [])) : (int)($r['segments'] ?? 0);
    $pl = "$dir/index.m3u8";
    $prepared = playlist_seconds($pl);
    $duration = (float)($r['duration'] ?? 0);
    $durationSource = $duration > 0 ? 'db' : '';

    if ($duration <= 0) {
        $fromCache = duration_from_media_cache($dir);
        if ($fromCache > 0) {
            $duration = $fromCache;
            $durationSource = 'media_info';
        }
    }

    if ($duration <= 0) {
        $fromLog = duration_from_ffmpeg_log("$dir/ffmpeg.log");
        if ($fromLog > 0) {
            $duration = $fromLog;
            $durationSource = 'ffmpeg_log';
        }
    }

    $preparedOut = $prepared ?: (float)($r['prepared_seconds'] ?? 0);
    $progress = (float)($r['progress'] ?? 0);
    $status = (string)($r['status'] ?? 'idle');
    $hasEndList = playlist_has_endlist($pl);
    $pid = (int)($r['pid'] ?? 0);
    $workerPid = (int)($r['worker_pid'] ?? 0);
    $heartbeat = (int)($r['last_heartbeat_at'] ?? 0);
    $updated = (int)($r['updated_at'] ?? 0);
    $now = prepare_now_ms();
    $isStalled = $status === 'processing' && (($heartbeat > 0 && $now - $heartbeat > 10 * 60 * 1000) || ($workerPid > 0 && !running($workerPid) && $pid > 0 && !running($pid)));
    $isComplete = is_file($pl) && filesize($pl) > 0 && $segments > 0 && $hasEndList && ($duration <= 0 || $preparedOut >= max(1, $duration - 8));
    if ($status === 'ready' && !$isComplete) {
        $status = 'error';
        if ($duration > 0 && $preparedOut > 0) $progress = min(99, round($preparedOut / $duration * 100, 1));
    }
    if ($duration > 0 && $preparedOut > 0 && $progress < 100) $progress = min(99, round($preparedOut / $duration * 100, 1));
    $totalSegments = $duration > 0 ? max(1, (int)ceil($duration / HLS_SEGMENT_SECONDS)) : 0;

    return [
        'id'=>(int)($r['id'] ?? 0),
        'content_id'=>(string)($r['content_id'] ?? ''),
        'prepare_key'=>$key,
        'title'=>(string)($r['title'] ?? ''),
        'quality'=>(string)($r['quality'] ?? 'fast'),
        'source_url'=>(string)($r['source_url'] ?? ''),
        'normalized_url'=>(string)($r['normalized_url'] ?? ''),
        'torrent_hash'=>$torrentHash,
        'file_index'=>$fileIndex,
        'stream_path'=>$streamPath,
        'audio_track'=>(int)($r['audio_track'] ?? 0),
        'audio_tracks'=>audio_tracks_from_media_cache($dir),
        'torrent_key'=>($torrentHash !== '' && $fileIndex >= 0) ? ($torrentHash . ':' . $fileIndex) : '',
        'status'=>$status,
        'progress'=>$progress,
        'duration'=>$duration,
        'duration_source'=>$durationSource,
        'prepared_seconds'=>$preparedOut,
        'segments'=>$segments,
        'total_segments'=>$totalSegments,
        'pid'=>$pid,
        'worker_pid'=>$workerPid,
        'running'=>running($pid),
        'worker_running'=>running($workerPid),
        'attempts'=>(int)($r['attempts'] ?? 0),
        'max_attempts'=>(int)($r['max_attempts'] ?? 3),
        'next_retry_at'=>(int)($r['next_retry_at'] ?? 0),
        'last_heartbeat_at'=>$heartbeat,
        'last_progress_at'=>(int)($r['last_progress_at'] ?? 0),
        'stalled'=>$isStalled,
        'error'=>(string)($r['error'] ?? ''),
        'hls_url'=>(string)($r['hls_url'] ?? prepare_public_hls_url($key)),
        'created_at'=>(int)($r['created_at'] ?? 0),
        'updated_at'=>$updated,
        'started_at'=>(int)($r['started_at'] ?? 0),
        'finished_at'=>(int)($r['finished_at'] ?? 0),
        'complete'=>$isComplete,
        'has_endlist'=>$hasEndList,
        'last_log'=>tail_file("$dir/ffmpeg.log", 3000),
    ];
}


/**


 * Ищет задачу подготовки по content_id.

 */


function prepare_get_row(PDO $pdo, string $cid): ?array {
    $st = $pdo->prepare('SELECT * FROM prepare_queue WHERE content_id=:cid LIMIT 1');
    $st->execute(['cid'=>$cid]);
    $r = $st->fetch(PDO::FETCH_ASSOC);
    return is_array($r) ? $r : null;
}

/**
 * Создаёт content_id для ручного добавления по stream URL.
 */
function prepare_stream_content_id(string $url, int $audioTrack = 0): string {
    $nu = norm_prepare_url(extract_prepare_source_url($url));
    $base = 'stream_' . substr(sha1($nu), 0, 16);
    return $audioTrack > 0 ? ($base . '_a' . $audioTrack) : $base;
}

/**
 * Извлекает torrent hash, index и путь файла из ссылки TorrServer.
 */
function prepare_torrent_identity(string $url): array {
    $url = extract_prepare_source_url($url);
    $nu = norm_prepare_url($url);
    $p = parse_url($nu);
    $q = [];
    if (!empty($p['query'])) parse_str($p['query'], $q);

    $hash = '';
    foreach (['link','hash','torrent','torrent_hash'] as $k) {
        if (isset($q[$k]) && trim((string)$q[$k]) !== '') {
            $hash = strtolower(trim((string)$q[$k]));
            break;
        }
    }
    $hash = preg_replace('~[^a-z0-9]+~i', '', $hash) ?: '';

    $index = -1;
    foreach (['index','id','file','file_index'] as $k) {
        if (isset($q[$k]) && preg_match('~^-?\d+$~', (string)$q[$k])) {
            $index = (int)$q[$k];
            break;
        }
    }

    $path = (string)($p['path'] ?? '');

    return [
        'torrent_hash' => $hash,
        'file_index' => $index,
        'stream_path' => $path,
        'torrent_key' => ($hash !== '' && $index >= 0) ? ($hash . ':' . $index) : '',
    ];
}

/**
 * Ищет задачу по source/normalized URL и torrent hash:index.
 */
function prepare_get_row_by_url(PDO $pdo, string $url, int $audioTrack = 0): ?array {
    $url = extract_prepare_source_url($url);
    if ($url === '' || !preg_match('#^https?://#i', $url)) return null;
    $nu = norm_prepare_url($url);
    $streamCid = prepare_stream_content_id($url, $audioTrack);
    $identity = prepare_torrent_identity($url);

    if ($identity['torrent_hash'] !== '' && (int)$identity['file_index'] >= 0) {
        $st = $pdo->prepare('SELECT * FROM prepare_queue WHERE torrent_hash=:th AND file_index=:fi AND audio_track=:at ORDER BY updated_at DESC LIMIT 1');
        $st->execute(['th'=>$identity['torrent_hash'], 'fi'=>(int)$identity['file_index'], 'at'=>$audioTrack]);
        $row = $st->fetch(PDO::FETCH_ASSOC);
        if (is_array($row)) return $row;
    }

    $st = $pdo->prepare('SELECT * FROM prepare_queue WHERE (normalized_url=:nu OR source_url=:src OR content_id=:cid) AND audio_track=:at ORDER BY updated_at DESC LIMIT 1');
    $st->execute(['nu'=>$nu, 'src'=>$url, 'cid'=>$streamCid, 'at'=>$audioTrack]);
    $r = $st->fetch(PDO::FETCH_ASSOC);
    return is_array($r) ? $r : null;
}


/**


 * Пишет короткие JSON-события в лог запуска/диагностики.

 */


function prepare_runtime_log(string $file, string $event, array $data=[]): void {
    $path = __DIR__ . '/data/' . $file;
    ensure_dir(dirname($path));
    $row = ['time'=>date('c'), 'event'=>$event] + $data;
    @file_put_contents($path, json_encode($row, JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES) . "\n", FILE_APPEND);
}

/**
 * Выполняет shell-команду и возвращает stdout/stderr/status.
 */
function exec_capture(string $cmd): array {
    $out = [];
    $code = 0;
    @exec($cmd . ' 2>&1', $out, $code);
    return ['code'=>$code, 'out'=>implode("\n", $out)];
}

/**
 * Находит CLI PHP, чтобы запускать worker из web-PHP.
 */
function resolve_php_cli(): array {
    $candidates = [];

    if (defined('PHP_BINARY') && PHP_BINARY) {
        $base = strtolower(basename(PHP_BINARY));
        if (!str_contains($base, 'fpm') && !str_contains($base, 'cgi')) {
            $candidates[] = PHP_BINARY;
        }
    }

    foreach ([
        '/usr/bin/php',
        '/usr/local/bin/php',
        '/bin/php',
        '/opt/remi/php83/root/usr/bin/php',
        '/opt/remi/php82/root/usr/bin/php',
        '/opt/remi/php81/root/usr/bin/php',
        '/opt/remi/php80/root/usr/bin/php',
        'php'
    ] as $candidate) {
        if (!in_array($candidate, $candidates, true)) $candidates[] = $candidate;
    }

    $checked = [];
    foreach ($candidates as $candidate) {
        $path = $candidate;

        if ($candidate === 'php') {
            $found = trim((string)@shell_exec('command -v php 2>/dev/null'));
            if ($found !== '') $path = $found;
        }

        if ($path === '') continue;
        if ($path !== 'php' && (!is_file($path) || !is_executable($path))) {
            $checked[] = ['candidate'=>$candidate, 'path'=>$path, 'ok'=>false, 'reason'=>'not executable'];
            continue;
        }

        $cmd = escapeshellarg($path) . ' -r ' . escapeshellarg('echo PHP_SAPI;');
        $res = exec_capture($cmd);
        $sapi = trim($res['out']);
        $ok = $res['code'] === 0 && $sapi === 'cli';
        $checked[] = ['candidate'=>$candidate, 'path'=>$path, 'ok'=>$ok, 'sapi'=>$sapi, 'code'=>$res['code']];
        if ($ok) return ['ok'=>true, 'bin'=>$path, 'checked'=>$checked];
    }

    return ['ok'=>false, 'bin'=>'', 'checked'=>$checked, 'error'=>'PHP CLI binary not found'];
}

/**
 * Запускает prepare_worker.php в фоне, не удерживая HTTP-запрос.
 */
function spawn_prepare_worker(): array {
    $worker = __DIR__ . '/prepare_worker.php';
    $stdout = __DIR__ . '/data/prepare_worker_stdout.log';

    if (!function_exists('exec')) {
        $r = ['ok'=>false, 'error'=>'exec disabled'];
        prepare_runtime_log('prepare_spawn.log', 'spawn_failed', $r);
        return $r;
    }

    if (!is_file($worker)) {
        $r = ['ok'=>false, 'error'=>'prepare_worker.php not found', 'worker'=>$worker];
        prepare_runtime_log('prepare_spawn.log', 'spawn_failed', $r);
        return $r;
    }

    $php = resolve_php_cli();
    if (!($php['ok'] ?? false)) {
        $r = ['ok'=>false, 'error'=>'PHP CLI not found', 'php'=>$php];
        prepare_runtime_log('prepare_spawn.log', 'spawn_failed', $r);
        return $r;
    }

    ensure_dir(dirname($stdout));
    $cmd = 'cd ' . escapeshellarg(__DIR__) .
        ' && nohup ' . escapeshellarg((string)$php['bin']) . ' ' . escapeshellarg($worker) .
        ' >> ' . escapeshellarg($stdout) . ' 2>&1 & echo $!';

    $out = [];
    $code = 0;
    @exec($cmd, $out, $code);
    $pid = (int)trim((string)($out[0] ?? '0'));
    $r = ['ok'=>$pid > 0, 'pid'=>$pid, 'code'=>$code, 'php'=>$php['bin'], 'worker'=>$worker, 'stdout'=>$stdout];
    if ($pid <= 0) $r['error'] = 'worker process was not started';
    prepare_runtime_log('prepare_spawn.log', $pid > 0 ? 'spawn_ok' : 'spawn_failed', $r);
    return $r;
}

/**
 * Возвращает диагностику worker-а: PHP CLI, lock, логи, последние ошибки.
 */
function prepare_worker_debug(string $dbFile, string $preparedRoot): void {
    $counts = [];
    $stalled = [];
    try {
        $pdo = prepare_db($dbFile);
        $rows = $pdo->query('SELECT status, COUNT(*) AS cnt FROM prepare_queue GROUP BY status')->fetchAll(PDO::FETCH_ASSOC) ?: [];
        foreach ($rows as $row) $counts[(string)$row['status']] = (int)$row['cnt'];
        $now = prepare_now_ms();
        $q = $pdo->query("SELECT id, content_id, title, status, pid, worker_pid, last_heartbeat_at, updated_at, attempts, max_attempts FROM prepare_queue WHERE status='processing' ORDER BY updated_at ASC LIMIT 20");
        foreach ($q->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
            $heartbeat = (int)($row['last_heartbeat_at'] ?? 0);
            $stalled[] = $row + [
                'worker_running'=>running((int)($row['worker_pid'] ?? 0)),
                'ffmpeg_running'=>running((int)($row['pid'] ?? 0)),
                'heartbeat_age_sec'=>$heartbeat > 0 ? round(($now - $heartbeat) / 1000) : null,
            ];
        }
    } catch (Throwable $e) {
        $counts['_error'] = $e->getMessage();
    }

    json([
        'ok'=>true,
        'api_version'=>API_VERSION,
        'exec_enabled'=>function_exists('exec'),
        'shell_exec_enabled'=>function_exists('shell_exec'),
        'php_binary'=>defined('PHP_BINARY') ? PHP_BINARY : '',
        'php_sapi'=>PHP_SAPI,
        'php_cli'=>resolve_php_cli(),
        'worker_file'=>__DIR__ . '/prepare_worker.php',
        'worker_file_exists'=>is_file(__DIR__ . '/prepare_worker.php'),
        'data_dir'=>__DIR__ . '/data',
        'data_writable'=>is_writable(__DIR__ . '/data'),
        'prepared_dir'=>$preparedRoot,
        'prepared_writable'=>is_writable($preparedRoot),
        'queue_db'=>$dbFile,
        'queue_db_exists'=>is_file($dbFile),
        'counts'=>$counts,
        'processing'=>$stalled,
        'lock_file'=>__DIR__ . '/data/prepare_worker.lock',
        'lock_file_exists'=>is_file(__DIR__ . '/data/prepare_worker.lock'),
        'lock_file_json'=>read_json(__DIR__ . '/data/prepare_worker.lock'),
        'spawn_log'=>tail_file(__DIR__ . '/data/prepare_spawn.log', 8000),
        'cron_log'=>tail_file(__DIR__ . '/data/prepare_cron.log', 8000),
        'worker_stdout'=>tail_file(__DIR__ . '/data/prepare_worker_stdout.log', 8000),
        'worker_runtime'=>tail_file(__DIR__ . '/data/prepare_worker_runtime.log', 8000),
        'worker_error'=>tail_file(__DIR__ . '/data/prepare_worker_error.log', 8000),
    ]);
}


/**


 * Создаёт или обновляет задачу фоновой подготовки и запускает worker.

 */


function prepare_start(string $dbFile, string $preparedRoot): void {
    $url = extract_prepare_source_url(req('url'));
    if ($url === '') json(['ok'=>false,'error'=>'url required'],400);
    if (!preg_match('#^https?://#i', $url)) json(['ok'=>false,'error'=>'Only http/https stream URLs are supported'],400);

    $nu = norm_prepare_url($url);
    $identity = prepare_torrent_identity($url);
    $torrentHash = $identity['torrent_hash'];
    $fileIndex = (int)$identity['file_index'];
    $streamPath = $identity['stream_path'];
    $cid = req('content_id');
    if ($cid === '') $cid = 'stream_' . substr(sha1($nu), 0, 16);
    $title = req('title', '');
    if ($title === '') $title = prepare_title_from_url($nu);
    $quality = req('quality', 'fast');
    $audioTrack = max(0, (int)req('audio_track', '0'));
    if ($cid === '' || str_starts_with($cid, 'stream_')) $cid = prepare_stream_content_id($nu, $audioTrack);
    $key = prepare_key($cid, $nu . '#a' . $audioTrack);
    $now = prepare_now_ms();
    $pdo = prepare_db($dbFile);
    $existing = prepare_get_row($pdo, $cid);
    if (!$existing) $existing = prepare_get_row_by_url($pdo, $url, $audioTrack);
    if ($existing && !empty($existing['content_id'])) {
        $cid = (string)$existing['content_id'];
        $key = (string)($existing['prepare_key'] ?: prepare_key($cid, $nu));
    }

    if ($existing && in_array((string)$existing['status'], ['queued','processing','retry','ready'], true)) {
        $spawn = null;
        if ((string)$existing['status'] !== 'ready') $spawn = spawn_prepare_worker();
        json(['ok'=>true,'already_exists'=>true,'item'=>prepare_row_out($existing,$preparedRoot),'spawn'=>$spawn]);
    }

    if ($existing) {
        $st = $pdo->prepare('UPDATE prepare_queue SET prepare_key=:pkey,title=:title,source_url=:src,normalized_url=:nu,torrent_hash=:th,file_index=:fi,stream_path=:sp,audio_track=:at,quality=:quality,status=\'queued\',progress=0,duration=0,prepared_seconds=0,segments=0,pid=0,worker_pid=0,attempts=0,max_attempts=3,next_retry_at=0,last_heartbeat_at=0,last_progress_at=0,cancel_requested=0,error=\'\',hls_url=:hls,updated_at=:updated,started_at=0,finished_at=0 WHERE content_id=:cid');
        $st->execute(['pkey'=>$key,'title'=>$title,'src'=>$url,'nu'=>$nu,'th'=>$torrentHash,'fi'=>$fileIndex,'sp'=>$streamPath,'at'=>$audioTrack,'quality'=>$quality,'hls'=>prepare_public_hls_url($key),'updated'=>$now,'cid'=>$cid]);
    } else {
        $st = $pdo->prepare('INSERT INTO prepare_queue(content_id,prepare_key,title,source_url,normalized_url,torrent_hash,file_index,stream_path,audio_track,quality,status,progress,hls_url,created_at,updated_at,max_attempts) VALUES(:cid,:pkey,:title,:src,:nu,:th,:fi,:sp,:at,:quality,\'queued\',0,:hls,:created,:updated,3)');
        $st->execute(['cid'=>$cid,'pkey'=>$key,'title'=>$title,'src'=>$url,'nu'=>$nu,'th'=>$torrentHash,'fi'=>$fileIndex,'sp'=>$streamPath,'at'=>$audioTrack,'quality'=>$quality,'hls'=>prepare_public_hls_url($key),'created'=>$now,'updated'=>$now]);
    }

    $spawn = spawn_prepare_worker();
    $row = prepare_get_row($pdo, $cid);
    json(['ok'=>true,'queued'=>true,'item'=>prepare_row_out($row ?: [],$preparedRoot),'spawn'=>$spawn]);
}


/**


 * Возвращает статус одной задачи по content_id или URL.

 */


function prepare_status(string $dbFile, string $preparedRoot): void {
    $cid = g('content_id');
    $url = g('url');
    $audioTrack = max(0, (int)g('audio_track','0'));
    $pdo = prepare_db($dbFile);
    if ($cid !== '' || $url !== '') {
        $row = null;
        if ($cid !== '') $row = prepare_get_row($pdo, $cid);
        if (!$row && $url !== '') $row = prepare_get_row_by_url($pdo, $url, $audioTrack);
        if (!$row) json(['ok'=>true,'exists'=>false,'item'=>['status'=>'idle','content_id'=>$cid ?: ($url !== '' ? prepare_stream_content_id($url, $audioTrack) : ''),'audio_track'=>$audioTrack]]);
        json(['ok'=>true,'exists'=>true,'item'=>prepare_row_out($row,$preparedRoot)]);
    }
    prepare_list($dbFile, $preparedRoot);
}

/**
 * Возвращает список задач очереди для prepare_queue.html и плагина Lampa.
 */
function prepare_list(string $dbFile, string $preparedRoot): void {
    $pdo = prepare_db($dbFile);
    $limit = max(1, min(200, (int)g('limit','50')));
    $total = (int)$pdo->query('SELECT COUNT(*) FROM prepare_queue')->fetchColumn();
    $rows = $pdo->query('SELECT * FROM prepare_queue ORDER BY updated_at DESC LIMIT ' . $limit)->fetchAll(PDO::FETCH_ASSOC) ?: [];
    $items = [];
    $rowErrors = [];

    foreach ($rows as $row) {
        try {
            $items[] = prepare_row_out($row, $preparedRoot);
        } catch (Throwable $e) {
            $rowErrors[] = [
                'id' => (int)($row['id'] ?? 0),
                'content_id' => (string)($row['content_id'] ?? ''),
                'error' => $e->getMessage(),
            ];
            $items[] = prepare_row_out_safe($row, $preparedRoot, $e->getMessage());
        }
    }

    json([
        'ok'=>true,
        'items'=>$items,
        'total'=>$total,
        'returned'=>count($items),
        'db_file'=>$dbFile,
        'db_exists'=>is_file($dbFile),
        'db_size'=>is_file($dbFile) ? (int)filesize($dbFile) : 0,
        'prepared_root'=>$preparedRoot,
        'row_errors'=>$rowErrors,
    ]);
}

/**
 * Формирует безопасный вывод строки БД, даже если часть данных повреждена.
 */
function prepare_row_out_safe(array $r, string $preparedRoot, string $err): array {
    $key = (string)($r['prepare_key'] ?? '');
    $dir = $key !== '' ? session_dir($preparedRoot, $key) : '';
    $segments = $dir !== '' && is_dir($dir) ? (count(glob("$dir/*.m4s") ?: []) + count(glob("$dir/*.ts") ?: [])) : (int)($r['segments'] ?? 0);
    return [
        'id'=>(int)($r['id'] ?? 0),
        'content_id'=>(string)($r['content_id'] ?? ''),
        'prepare_key'=>$key,
        'title'=>(string)($r['title'] ?? ''),
        'quality'=>(string)($r['quality'] ?? 'fast'),
        'audio_track'=>(int)($r['audio_track'] ?? 0),
        'audio_tracks'=>[],
        'status'=>(string)($r['status'] ?? 'error'),
        'progress'=>(float)($r['progress'] ?? 0),
        'duration'=>(float)($r['duration'] ?? 0),
        'duration_source'=>'db_safe',
        'prepared_seconds'=>(float)($r['prepared_seconds'] ?? 0),
        'segments'=>$segments,
        'total_segments'=>0,
        'pid'=>(int)($r['pid'] ?? 0),
        'worker_pid'=>(int)($r['worker_pid'] ?? 0),
        'running'=>running((int)($r['pid'] ?? 0)),
        'worker_running'=>running((int)($r['worker_pid'] ?? 0)),
        'attempts'=>(int)($r['attempts'] ?? 0),
        'max_attempts'=>(int)($r['max_attempts'] ?? 3),
        'next_retry_at'=>(int)($r['next_retry_at'] ?? 0),
        'last_heartbeat_at'=>(int)($r['last_heartbeat_at'] ?? 0),
        'last_progress_at'=>(int)($r['last_progress_at'] ?? 0),
        'stalled'=>false,
        'error'=>'prepare_list row render failed: ' . $err . "
Original error: " . (string)($r['error'] ?? ''),
        'hls_url'=>$key !== '' ? prepare_public_hls_url($key) : '',
        'created_at'=>(int)($r['created_at'] ?? 0),
        'updated_at'=>(int)($r['updated_at'] ?? 0),
        'started_at'=>(int)($r['started_at'] ?? 0),
        'finished_at'=>(int)($r['finished_at'] ?? 0),
        'complete'=>false,
        'has_endlist'=>false,
        'last_log'=>$dir !== '' ? tail_file("$dir/ffmpeg.log", 3000) : '',
    ];
}

/**
 * Диагностический endpoint для просмотра состояния БД очереди.
 */
function prepare_inspect(string $dbFile, string $preparedRoot): void {
    $pdo = prepare_db($dbFile);
    $limit = max(1, min(50, (int)g('limit','10')));
    $total = (int)$pdo->query('SELECT COUNT(*) FROM prepare_queue')->fetchColumn();
    $rows = $pdo->query('SELECT id,content_id,prepare_key,title,status,progress,duration,prepared_seconds,segments,pid,worker_pid,attempts,audio_track,updated_at,error FROM prepare_queue ORDER BY updated_at DESC LIMIT ' . $limit)->fetchAll(PDO::FETCH_ASSOC) ?: [];
    $preparedDirs = [];
    if (is_dir($preparedRoot)) {
        foreach (scandir($preparedRoot) ?: [] as $i) {
            if ($i === '.' || $i === '..') continue;
            $p = $preparedRoot . '/' . $i;
            if (!is_dir($p)) continue;
            $preparedDirs[] = [
                'name'=>$i,
                'mtime'=>filemtime($p) ?: 0,
                'segments'=>count(glob("$p/*.m4s") ?: []) + count(glob("$p/*.ts") ?: []),
                'has_index'=>is_file("$p/index.m3u8"),
                'seconds'=>playlist_seconds("$p/index.m3u8"),
            ];
        }
        usort($preparedDirs, fn($a,$b)=>$b['mtime'] <=> $a['mtime']);
        $preparedDirs = array_slice($preparedDirs, 0, $limit);
    }
    json([
        'ok'=>true,
        'api_version'=>API_VERSION,
        'db_file'=>$dbFile,
        'db_exists'=>is_file($dbFile),
        'db_size'=>is_file($dbFile) ? (int)filesize($dbFile) : 0,
        'total'=>$total,
        'rows'=>$rows,
        'prepared_root'=>$preparedRoot,
        'prepared_root_exists'=>is_dir($preparedRoot),
        'prepared_dirs'=>$preparedDirs,
    ]);
}

/**
 * Удаляет задачу и её prepared-директорию.
 */
function prepare_delete(string $dbFile, string $preparedRoot): void {
    $cid = g('content_id');
    if ($cid === '') json(['ok'=>false,'error'=>'content_id required'],400);
    $pdo = prepare_db($dbFile);
    $row = prepare_get_row($pdo, $cid);
    if ($row) {
        $st = $pdo->prepare('UPDATE prepare_queue SET cancel_requested=1,updated_at=:now WHERE content_id=:cid');
        $st->execute(['now'=>prepare_now_ms(),'cid'=>$cid]);
        $pid = (int)($row['pid'] ?? 0);
        $workerPid = (int)($row['worker_pid'] ?? 0);
        if ($pid > 0 && running($pid)) kill_pid($pid);
        if ($workerPid > 0 && $workerPid !== getmypid() && running($workerPid)) kill_pid($workerPid);
        $key = (string)$row['prepare_key'];
        rrmdir(session_dir($preparedRoot, $key));
        $st = $pdo->prepare('DELETE FROM prepare_queue WHERE content_id=:cid');
        $st->execute(['cid'=>$cid]);
    }
    json(['ok'=>true,'deleted'=>true,'content_id'=>$cid]);
}



/**



 * Сбрасывает ошибочную/зависшую задачу в повторную обработку.


 */



function prepare_retry(string $dbFile, string $preparedRoot): void {
    $cid = g('content_id');
    if ($cid === '') json(['ok'=>false,'error'=>'content_id required'],400);
    $pdo = prepare_db($dbFile);
    $row = prepare_get_row($pdo, $cid);
    if (!$row) json(['ok'=>false,'error'=>'queue item not found'],404);
    $pid = (int)($row['pid'] ?? 0);
    $workerPid = (int)($row['worker_pid'] ?? 0);
    if ($pid > 0 && running($pid)) kill_pid($pid);
    if ($workerPid > 0 && $workerPid !== getmypid() && running($workerPid)) kill_pid($workerPid);
    rrmdir(session_dir($preparedRoot, (string)$row['prepare_key']));
    $now = prepare_now_ms();
    $st = $pdo->prepare("UPDATE prepare_queue SET status='queued',progress=0,prepared_seconds=0,segments=0,pid=0,worker_pid=0,attempts=0,next_retry_at=0,last_heartbeat_at=0,last_progress_at=0,cancel_requested=0,error='',updated_at=:now,started_at=0,finished_at=0 WHERE content_id=:cid");
    $st->execute(['now'=>$now,'cid'=>$cid]);
    $spawn = spawn_prepare_worker();
    $row = prepare_get_row($pdo, $cid);
    json(['ok'=>true,'retried'=>true,'item'=>prepare_row_out($row ?: [],$preparedRoot),'spawn'=>$spawn]);
}

/**
 * Принудительно сбрасывает зависшие задачи в retry.
 */
function prepare_reset_stalled(string $dbFile, string $preparedRoot): void {
    $pdo = prepare_db($dbFile);
    $changed = prepare_mark_stalled_jobs($pdo, $preparedRoot, true);
    $spawn = spawn_prepare_worker();
    json(['ok'=>true,'changed'=>$changed,'spawn'=>$spawn]);
}

/**
 * Находит задачи без heartbeat/progress и помечает их как retry/stalled.
 */
function prepare_mark_stalled_jobs(PDO $pdo, string $preparedRoot, bool $force=false): array {
    $now = prepare_now_ms();
    $staleMs = 10 * 60 * 1000;
    $rows = $pdo->query("SELECT * FROM prepare_queue WHERE status='processing'")->fetchAll(PDO::FETCH_ASSOC) ?: [];
    $changed = [];
    foreach ($rows as $row) {
        $pid = (int)($row['pid'] ?? 0);
        $workerPid = (int)($row['worker_pid'] ?? 0);
        $heartbeat = (int)($row['last_heartbeat_at'] ?? 0);
        $stale = $force || ($heartbeat > 0 && $now - $heartbeat > $staleMs) || ($workerPid > 0 && !running($workerPid) && ($pid <= 0 || !running($pid)));
        if (!$stale) continue;
        if ($pid > 0 && running($pid)) kill_pid($pid);
        if ($workerPid > 0 && $workerPid !== getmypid() && running($workerPid)) kill_pid($workerPid);
        rrmdir(session_dir($preparedRoot, (string)$row['prepare_key']));
        $attempts = (int)($row['attempts'] ?? 0);
        $maxAttempts = max(1, (int)($row['max_attempts'] ?? 3));
        $status = $attempts < $maxAttempts ? 'retry' : 'error';
        $nextRetryAt = $status === 'retry' ? $now : 0;
        $error = 'Watchdog: worker/ffmpeg stalled or died';
        $st = $pdo->prepare('UPDATE prepare_queue SET status=:status,pid=0,worker_pid=0,next_retry_at=:next_retry_at,last_heartbeat_at=0,last_progress_at=0,error=:error,updated_at=:updated WHERE id=:id');
        $st->execute(['status'=>$status,'next_retry_at'=>$nextRetryAt,'error'=>$error,'updated'=>$now,'id'=>(int)$row['id']]);
        $changed[] = ['id'=>(int)$row['id'],'content_id'=>(string)$row['content_id'],'status'=>$status,'attempts'=>$attempts,'max_attempts'=>$maxAttempts];
    }
    return $changed;
}

/**
 * Отдаёт готовые HLS-файлы из data/prepared с правильными Content-Type.
 */
function serve_prepared_hls(string $root): void {
    $key = sid(g('key'));
    $file = g('file','index.m3u8');
    if ($key === '') { http_response_code(400); echo 'key required'; exit; }
    if (!preg_match('~^[a-zA-Z0-9_.-]+$~',$file)) { http_response_code(400); echo 'invalid file'; exit; }
    $dir = session_dir($root,$key);
    $path = "$dir/$file";
    if (!is_file($path)) { http_response_code(404); echo 'file not found'; exit; }

    if (str_ends_with($file,'.m3u8')) {
        header('Content-Type: application/vnd.apple.mpegurl');
        header('Cache-Control: no-cache, no-store, must-revalidate');
        header('Pragma: no-cache');
        $lines = preg_split('~\r\n|\r|\n~',(string)file_get_contents($path));
        $out = [];
        foreach ($lines as $line) {
            $t = trim((string)$line);
            if (str_starts_with($t,'#EXT-X-MAP:') && preg_match('~URI="([^"]+)"~',$t,$m) && preg_match('~^[a-zA-Z0-9_.-]+\.mp4$~',$m[1])) {
                $u = lampa_sync_api_url(['prepared_hls'=>'1','key'=>$key,'file'=>$m[1]]);
                $out[] = preg_replace('~URI="([^"]+)"~','URI="'.$u.'"',$line);
            } elseif ($t !== '' && $t[0] !== '#' && preg_match('~^[a-zA-Z0-9_.-]+\.(ts|m4s|mp4)$~',$t)) {
                $out[] = lampa_sync_api_url(['prepared_hls'=>'1','key'=>$key,'file'=>$t]);
            } else $out[] = $line;
        }
        echo implode("\n",$out);
        exit;
    }

    if (str_ends_with($file,'.ts')) { header('Content-Type: video/mp2t'); }
    elseif (str_ends_with($file,'.m4s')) { header('Content-Type: video/iso.segment'); }
    elseif (str_ends_with($file,'.mp4')) { header('Content-Type: video/mp4'); }
    else { http_response_code(403); echo 'forbidden'; exit; }
    header('Cache-Control: public, max-age=31536000, immutable');
    header('Content-Length: '.filesize($path));
    readfile($path);
    exit;
}

/**
 * Возвращает диагностическую информацию о PHP, SQLite, ffmpeg и директориях.
 */
function debug(string $data,string $hls): void {
    $fv = is_file(FFMPEG_BIN)&&is_executable(FFMPEG_BIN) ? trim((string)@shell_exec(escapeshellarg(FFMPEG_BIN).' -version 2>&1 | head -n 1')) : 'not found/executable';
    $pv = is_file(FFPROBE_BIN)&&is_executable(FFPROBE_BIN) ? trim((string)@shell_exec(escapeshellarg(FFPROBE_BIN).' -version 2>&1 | head -n 1')) : 'not found/executable';
    json(['ok'=>true,'api_version'=>API_VERSION,'php_version'=>PHP_VERSION,'pdo_sqlite'=>extension_loaded('pdo_sqlite'),'sqlite3'=>extension_loaded('sqlite3'),'curl'=>extension_loaded('curl'),'exec_enabled'=>function_exists('exec'),'ffmpeg_bin'=>FFMPEG_BIN,'ffmpeg_exists'=>is_file(FFMPEG_BIN),'ffmpeg_executable'=>is_executable(FFMPEG_BIN),'ffmpeg_version'=>$fv,'ffprobe_bin'=>FFPROBE_BIN,'ffprobe_exists'=>is_file(FFPROBE_BIN),'ffprobe_executable'=>is_executable(FFPROBE_BIN),'ffprobe_version'=>$pv,'data_dir'=>$data,'data_dir_writable'=>is_writable($data),'hls_dir'=>$hls,'hls_dir_writable'=>is_writable($hls),'hls_total_bytes'=>dsize($hls)]);
}
/**
 * Проверяет доступность исходного TorrServer-потока первыми байтами.
 */
function debug_stream(): void {
    $u=g('url'); if($u==='') json(['ok'=>false,'error'=>'url required'],400); $nu=norm_url($u); $heads=array_values(array_filter(['Range: bytes=0-511',auth_header(),'User-Agent: Mozilla/5.0 LampaSync/1.0'])); $rh=[]; $ch=curl_init($nu); curl_setopt_array($ch,[CURLOPT_FOLLOWLOCATION=>true,CURLOPT_RETURNTRANSFER=>true,CURLOPT_HTTPHEADER=>$heads,CURLOPT_CONNECTTIMEOUT=>15,CURLOPT_TIMEOUT=>20,CURLOPT_HEADERFUNCTION=>function($ch,$h)use(&$rh){$l=strlen($h);$h=trim($h);if($h!=='')$rh[]=$h;return $l;}]); $body=curl_exec($ch); $err=curl_error($ch); $code=(int)curl_getinfo($ch,CURLINFO_HTTP_CODE); $ct=(string)curl_getinfo($ch,CURLINFO_CONTENT_TYPE); curl_close($ch); $body=is_string($body)?$body:''; json(['ok'=>$code>=200&&$code<400,'original_url'=>$u,'normalized_url'=>$nu,'contains_preload'=>str_contains($nu,'preload'),'contains_play'=>str_contains($nu,'play'),'prepare_normalized_url'=>norm_prepare_url($u),'input_has_runtime_seek'=>url_query_has_runtime_seek($u),'http_code'=>$code,'content_type'=>$ct,'curl_error'=>$err,'headers'=>array_slice($rh,0,20),'first_bytes_len'=>strlen($body),'first_bytes_hex'=>bin2hex(substr($body,0,32))]);
}
/**
 * Удаляет старые временные HLS-сессии и следит за лимитом размера.
 */
function cleanup_hls(string $root,bool $force): void { if(!is_dir($root)) return; $now=time(); $sessions=[]; foreach(scandir($root)?:[] as $i){ if($i==='.'||$i==='..')continue; $d="$root/$i"; if(!is_dir($d))continue; $touch=is_file("$d/last_touch.txt")?filemtime("$d/last_touch.txt"):filemtime($d); $age=$now-($touch?:$now); $pid=is_file("$d/ffmpeg.pid")?(int)trim((string)file_get_contents("$d/ffmpeg.pid")):0; $run=running($pid); $stopped=is_file("$d/stopped.txt"); $size=dsize($d); if($force || (!$run && $age>HLS_TTL) || ($stopped && $age>HLS_DONE_TTL)){ if($run) kill_pid($pid); rrmdir($d); continue;} $sessions[]=['d'=>$d,'t'=>$touch?:$now,'run'=>$run,'pid'=>$pid,'size'=>$size]; } $total=array_sum(array_column($sessions,'size')); if($total<=HLS_MAX_BYTES)return; usort($sessions,fn($a,$b)=>$a['t']<=>$b['t']); foreach($sessions as $s){ if($total<=HLS_MAX_BYTES)break; if($s['run'])continue; rrmdir($s['d']); $total-=$s['size']; } }

/**
 * Проксирует исходный поток TorrServer с поддержкой Range-запросов.
 */
function proxy_stream(): void { $u=g('url'); if($u==='' || !preg_match('#^https?://#i',$u)){http_response_code(400);echo'invalid url';exit;} $u=norm_url($u); while(ob_get_level()) ob_end_clean(); set_time_limit(0); $heads=array_values(array_filter([auth_header(),'User-Agent: Mozilla/5.0 LampaSync/1.0'])); if(!empty($_SERVER['HTTP_RANGE'])) $heads[]='Range: '.$_SERVER['HTTP_RANGE']; $ch=curl_init($u); curl_setopt_array($ch,[CURLOPT_FOLLOWLOCATION=>true,CURLOPT_RETURNTRANSFER=>false,CURLOPT_HTTPHEADER=>$heads,CURLOPT_CONNECTTIMEOUT=>15,CURLOPT_TIMEOUT=>0,CURLOPT_BUFFERSIZE=>1048576,CURLOPT_WRITEFUNCTION=>function($ch,$chunk){echo $chunk; flush(); return strlen($chunk);},CURLOPT_HEADERFUNCTION=>function($ch,$h){$l=strlen($h);$h=trim($h); if($h==='')return $l; if(preg_match('#^HTTP/\S+\s+(\d+)#i',$h,$m)){http_response_code((int)$m[1]);return $l;} foreach(['Content-Type:','Content-Length:','Content-Range:','Accept-Ranges:','Cache-Control:','Last-Modified:','ETag:'] as $a){ if(stripos($h,$a)===0){header($h);break;}} return $l;}]); $ok=curl_exec($ch); if($ok===false){http_response_code(502);echo curl_error($ch);} curl_close($ch); exit; }

/**
 * Получает codec/duration через ffprobe и кэширует результат в media_info.json.
 */
function media_info(string $url,string $dir): array {
    $cache="$dir/media_info.json";
    if(is_file($cache)&&filesize($cache)>0)return read_json($cache);

    $headers=lampa_sync_ffmpeg_headers();
    $cmd='timeout 25s '.escapeshellarg(FFPROBE_BIN).
        ' -v error'.
        ' -analyzeduration 100M'.
        ' -probesize 100M'.
        ' -headers '.escapeshellarg($headers).
        ' -print_format json -show_format -show_streams '.escapeshellarg($url).' 2>&1';
    $raw=(string)@shell_exec($cmd);
    $pos=strpos($raw,'{');
    $data=json_decode($pos!==false?substr($raw,$pos):'',true);
    if(!is_array($data))$data=['raw'=>$raw,'streams'=>[],'format'=>[]];

    $info=[
        'duration'=>0,
        'video_codec'=>'',
        'video_pix_fmt'=>'',
        'video_width'=>0,
        'video_height'=>0,
        'audio_codec'=>'',
        'audio_channels'=>0,
        'audio_tracks'=>[],
        'subtitle_tracks'=>[],
        'raw'=>$data,
    ];

    if(!empty($data['format']['duration']))$info['duration']=max(0,(float)$data['format']['duration']);

    $audioIndex=0;
    foreach(($data['streams']??[]) as $s){
        if(($s['codec_type']??'')==='video' && $info['video_codec']===''){
            $info['video_codec']=strtolower((string)($s['codec_name']??''));
            $info['video_pix_fmt']=strtolower((string)($s['pix_fmt']??''));
            $info['video_width']=(int)($s['width']??0);
            $info['video_height']=(int)($s['height']??0);
            if($info['duration']<=0 && !empty($s['duration']))$info['duration']=(float)$s['duration'];
        }

        if(($s['codec_type']??'')==='audio'){
            $tags=is_array($s['tags']??null)?$s['tags']:[];
            $disp=is_array($s['disposition']??null)?$s['disposition']:[];
            $track=[
                'audio_index'=>$audioIndex,
                'stream_index'=>(int)($s['index']??$audioIndex),
                'codec'=>strtolower((string)($s['codec_name']??'')),
                'channels'=>(int)($s['channels']??0),
                'language'=>strtolower((string)($tags['language']??'')),
                'title'=>(string)($tags['title']??''),
                'default'=>!empty($disp['default']),
            ];
            $track['label']=audio_track_label($track);
            $info['audio_tracks'][]=$track;

            if($info['audio_codec']===''){
                $info['audio_codec']=$track['codec'];
                $info['audio_channels']=$track['channels'];
                if($info['duration']<=0 && !empty($s['duration']))$info['duration']=(float)$s['duration'];
            }
            $audioIndex++;
        }
    }

    $subtitleIndex=0;
    foreach(($data['streams']??[]) as $s){
        if(($s['codec_type']??'')==='subtitle'){
            $tags=is_array($s['tags']??null)?$s['tags']:[];
            $disp=is_array($s['disposition']??null)?$s['disposition']:[];
            $track=[
                'subtitle_index'=>$subtitleIndex,
                'stream_index'=>(int)($s['index']??$subtitleIndex),
                'codec'=>strtolower((string)($s['codec_name']??'')),
                'language'=>strtolower((string)($tags['language']??'')),
                'title'=>(string)($tags['title']??''),
                'default'=>!empty($disp['default']),
                'forced'=>!empty($disp['forced']),
            ];
            $track['supported']=subtitle_track_supported($track);
            $track['label']=subtitle_track_label($track);
            $info['subtitle_tracks'][]=$track;
            $subtitleIndex++;
        }
    }

    write_json($cache,$info);
    return $info;
}

/**
 * Формирует читаемую подпись аудиодорожки для интерфейса плеера.
 */
function audio_track_label(array $track): string {
    $parts=[];
    $n=(int)($track['audio_index']??0)+1;
    $parts[]='Аудио '.$n;
    if(!empty($track['language']))$parts[]=strtoupper((string)$track['language']);
    if(!empty($track['title']))$parts[]=(string)$track['title'];
    if(!empty($track['codec']))$parts[]=strtoupper((string)$track['codec']);
    if(!empty($track['channels']))$parts[]=(string)$track['channels'].'ch';
    if(!empty($track['default']))$parts[]='default';
    return implode(' · ', $parts);
}

/**
 * Проверяет, можно ли отдать дорожку субтитров как WebVTT.
 * Текстовые форматы ffmpeg обычно умеет конвертировать в .vtt.
 * Bitmap-субтитры вроде PGS/VobSub здесь не поддерживаются: для них нужен burn-in или OCR.
 */
function subtitle_track_supported(array $track): bool {
    $codec = strtolower((string)($track['codec'] ?? ''));
    return in_array($codec, ['subrip','srt','ass','ssa','webvtt','mov_text','text'], true);
}

/**
 * Формирует читаемую подпись субтитров для интерфейса плеера.
 */
function subtitle_track_label(array $track): string {
    $parts=[];
    $n=(int)($track['subtitle_index']??0)+1;
    $parts[]='Субтитры '.$n;
    if(!empty($track['language']))$parts[]=strtoupper((string)$track['language']);
    if(!empty($track['title']))$parts[]=(string)$track['title'];
    if(!empty($track['codec']))$parts[]=strtoupper((string)$track['codec']);
    if(!empty($track['forced']))$parts[]='forced';
    if(!empty($track['default']))$parts[]='default';
    if(empty($track['supported']))$parts[]='не webvtt';
    return implode(' · ', $parts);
}

/**
 * Не даёт выбрать несуществующую дорожку субтитров.
 */
function normalize_subtitle_track(array $mediaInfo, int $requested): int {
    $tracks=is_array($mediaInfo['subtitle_tracks']??null)?$mediaInfo['subtitle_tracks']:[];
    if(!$tracks)return -1;
    foreach($tracks as $track){
        if((int)($track['subtitle_index']??-1)===$requested)return $requested;
    }
    return -1;
}

/**
 * Конвертирует выбранную встроенную дорожку субтитров в WebVTT и отдаёт её браузеру.
 * Важно: субтитры извлекаются полным проходом от начала файла.
 * Seek внутри MKV через TorrServer часто ломает demuxer: ffmpeg может получить
 * байтовый Range не с начала EBML-элемента и упасть с invalid EBML number.
 */

/**
 * Проверяет, похож ли готовый файл на валидный WebVTT.
 * Одного заголовка WEBVTT недостаточно: внутри должна быть хотя бы одна строка времени.
 */
function subtitle_vtt_is_valid(string $file): bool {
    if (!is_file($file) || filesize($file) <= 0) return false;
    $txt = (string)file_get_contents($file);
    if (stripos($txt, 'WEBVTT') === false) return false;
    return strpos($txt, '-->') !== false;
}

/**
 * Собирает команду ffmpeg для извлечения одной дорожки субтитров в WebVTT.
 */
function subtitle_vtt_build_cmd(string $url, string $map, float $start, string $outFile, string $logFile): string {
    $headers = lampa_sync_ffmpeg_headers();
    $parts = [
        'timeout 240s',
        escapeshellarg(FFMPEG_BIN),
        '-y',
        '-hide_banner',
        '-nostdin',
        '-loglevel warning',
        '-rw_timeout 600000000',
        '-reconnect 1',
        '-reconnect_streamed 1',
        '-reconnect_on_network_error 1',
        '-reconnect_on_http_error 4xx,5xx',
        '-reconnect_delay_max 30',
        '-headers '.escapeshellarg($headers),
    ];

    /*
     * Не используем -ss перед входом для субтитров.
     * На TorrServer/MKV такой seek может приводить к ошибке вида
     * "invalid as first byte of an EBML number": ffmpeg начинает читать поток
     * с середины EBML-блока. Поэтому WebVTT создаётся полным проходом с начала,
     * а player.html сам выбирает локальное или глобальное время для overlay.
     */
    // $start намеренно не применяется в ffmpeg-команде: см. комментарий выше.

    /* -fix_sub_duration — input-опция, она должна идти до -i. */
    $parts[] = '-fix_sub_duration';
    $parts[] = '-i '.escapeshellarg($url);
    $parts[] = '-map '.escapeshellarg($map);
    $parts[] = '-vn';
    $parts[] = '-an';
    $parts[] = '-dn';
    $parts[] = '-c:s webvtt';
    $parts[] = '-f webvtt';
    $parts[] = escapeshellarg($outFile);

    return implode(' ', $parts).' > '.escapeshellarg($logFile).' 2>&1';
}

function subtitle_vtt_pid_running(int $pid): bool {
    if ($pid <= 0) return false;
    if (function_exists('posix_kill')) return @posix_kill($pid, 0);
    $code = 1;
    @exec('kill -0 '.(int)$pid.' 2>/dev/null', $out, $code);
    return $code === 0;
}

function subtitle_vtt_spawn_cmd(string $cmd, string $pidFile, string $statusFile): array {
    $payload = [
        'status' => 'processing',
        'started_at' => time(),
        'updated_at' => time(),
    ];
    write_json($statusFile, $payload);

    $spawn = 'sh -c '.escapeshellarg($cmd).' >/dev/null 2>&1 & echo $!';
    $out = [];
    $code = 0;
    @exec($spawn, $out, $code);
    $pid = isset($out[0]) ? (int)$out[0] : 0;

    if ($pid > 0) {
        @file_put_contents($pidFile, (string)$pid);
        $payload['pid'] = $pid;
        write_json($statusFile, $payload);
    }

    return ['ok' => $pid > 0, 'pid' => $pid, 'code' => $code, 'out' => $out];
}

function subtitle_vtt_attempts_for_track(int $streamIndex, int $track): array {
    $attempts=[];
    if($streamIndex>=0)$attempts[]=['name'=>'absolute_stream_index','map'=>'0:'.$streamIndex];
    $attempts[]=['name'=>'relative_subtitle_index','map'=>'0:s:'.$track];
    return $attempts;
}

function subtitle_vtt_start_async(string $nu, int $track, int $streamIndex, float $start, array $info, string $outFile, string $logFile, string $metaFile, string $cmdFile, string $pidFile, string $statusFile): array {
    $attempts = subtitle_vtt_attempts_for_track($streamIndex, $track);
    $map = (string)$attempts[0]['map'];
    $cmd = subtitle_vtt_build_cmd($nu, $map, $start, $outFile, $logFile);
    @unlink($outFile);
    @unlink($logFile);
    @file_put_contents($cmdFile, $cmd);

    write_json($metaFile, [
        'url'=>$nu,
        'subtitle_track'=>$track,
        'stream_index'=>$streamIndex,
        'requested_start'=>$start,
        'extraction_mode'=>'full_scan_from_start_no_seek',
        'created_at'=>time(),
        'track'=>$info,
        'attempts'=>[['name'=>$attempts[0]['name'], 'map'=>$map, 'status'=>'spawned_async']],
    ]);

    return subtitle_vtt_spawn_cmd($cmd, $pidFile, $statusFile);
}

/**
 * Конвертирует выбранную встроенную дорожку субтитров в WebVTT и отдаёт её браузеру.
 *
 * Важный нюанс: извлечение субтитров из TorrServer-потока может занимать дольше,
 * чем таймаут nginx/php-fpm. Поэтому endpoint работает асинхронно:
 * - если subtitle.vtt уже готов, отдаём его сразу;
 * - если не готов, запускаем ffmpeg в фоне и возвращаем JSON `pending`;
 * - player.html опрашивает endpoint, пока файл не появится.
 */
function subtitle_vtt_endpoint(string $hlsRoot): void {
    $url=req('url');
    if($url==='' || !preg_match('#^https?://#i',$url)){http_response_code(400); header('Content-Type: text/plain; charset=utf-8'); echo 'url required'; exit;}

    $track=max(0,(int)req('subtitle_track','0'));
    $start=max(0,(float)req('start','0'));
    $debug=req('debug','')==='1';
    $nu=norm_url($url);
    $probeDir=session_dir($hlsRoot,'probe_'.substr(sha1($nu),0,16));
    ensure_dir($probeDir);
    $mi=media_info($nu,$probeDir);
    $track=normalize_subtitle_track($mi,$track);
    if($track<0){http_response_code(404); header('Content-Type: text/plain; charset=utf-8'); echo 'subtitle track not found'; exit;}

    $tracks=is_array($mi['subtitle_tracks']??null)?$mi['subtitle_tracks']:[];
    $info=null;
    foreach($tracks as $t){ if((int)($t['subtitle_index']??-1)===$track){$info=$t; break;} }
    if(!$info || empty($info['supported'])){http_response_code(415); header('Content-Type: text/plain; charset=utf-8'); echo 'subtitle codec is not supported for WebVTT'; exit;}

    $streamIndex=(int)($info['stream_index']??-1);
    $bucket='sub_'.substr(sha1($nu.'|sub:'.$track.'|stream:'.$streamIndex.'|full-scan-v2'),0,24);
    $dir=session_dir($hlsRoot,$bucket);
    ensure_dir($dir);
    touch_session($dir);
    $outFile=$dir.'/subtitle.vtt';
    $logFile=$dir.'/subtitle.log';
    $metaFile=$dir.'/subtitle_meta.json';
    $cmdFile=$dir.'/subtitle_cmd.txt';
    $pidFile=$dir.'/subtitle.pid';
    $statusFile=$dir.'/subtitle_status.json';

    $pid=is_file($pidFile)?(int)trim((string)file_get_contents($pidFile)):0;
    $running=subtitle_vtt_pid_running($pid);

    if(!subtitle_vtt_is_valid($outFile) && !$running){
        /*
         * Если прошлый ffmpeg уже завершился, но WebVTT не появился, не запускаем
         * бесконечный цикл на каждом polling-запросе: даём повтор через 30 секунд.
         */
        $status=read_json($statusFile);
        $last=(int)($status['updated_at'] ?? 0);
        $failedRecently=($last > 0 && time() - $last < 30 && !empty($status['failed']));

        if(!$failedRecently){
            $spawn=subtitle_vtt_start_async($nu,$track,$streamIndex,$start,$info,$outFile,$logFile,$metaFile,$cmdFile,$pidFile,$statusFile);
            $pid=(int)($spawn['pid'] ?? 0);
            $running=$pid>0;
        }
    }

    $valid=subtitle_vtt_is_valid($outFile);
    if(!$valid && !$running && is_file($logFile) && filesize($logFile)>0){
        $status=read_json($statusFile);
        $status['status']='failed';
        $status['failed']=true;
        $status['updated_at']=time();
        write_json($statusFile,$status);
    }

    if($debug){
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode([
            'ok'=>$valid,
            'pending'=>!$valid && $running,
            'running'=>$running,
            'pid'=>$pid,
            'track'=>$info,
            'subtitle_track'=>$track,
            'stream_index'=>$streamIndex,
            'start'=>$start,
            'extraction_mode'=>'full_scan_from_start_no_seek',
            'out_file'=>$outFile,
            'bytes'=>is_file($outFile)?filesize($outFile):0,
            'preview'=>is_file($outFile)?substr((string)file_get_contents($outFile),0,1200):'',
            'log_tail'=>tail_file($logFile,4000),
            'cmd'=>is_file($cmdFile)?(string)file_get_contents($cmdFile):'',
            'status'=>read_json($statusFile),
            'meta'=>read_json($metaFile),
        ], JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
        exit;
    }

    if(!$valid){
        http_response_code($running ? 202 : 500);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode([
            'ok'=>false,
            'pending'=>$running,
            'running'=>$running,
            'pid'=>$pid,
            'error'=>$running ? 'subtitle conversion is still running' : 'subtitle conversion failed or produced empty WebVTT',
            'log_tail'=>tail_file($logFile,1200),
        ], JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
        exit;
    }

    header('Content-Type: text/vtt; charset=utf-8');
    header('Cache-Control: public, max-age=86400');
    readfile($outFile);
    exit;
}

function audio_tracks_from_media_cache(string $dir): array {
    $mi=read_json($dir.'/media_info.json');
    return is_array($mi['audio_tracks']??null)?$mi['audio_tracks']:[];
}

/**
 * Не даёт выбрать несуществующую аудиодорожку.
 */
function normalize_audio_track(array $mediaInfo, int $requested): int {
    $tracks=is_array($mediaInfo['audio_tracks']??null)?$mediaInfo['audio_tracks']:[];
    if(!$tracks)return 0;
    $requested=max(0,$requested);
    foreach($tracks as $track){
        if((int)($track['audio_index']??-1)===$requested)return $requested;
    }
    return (int)($tracks[0]['audio_index']??0);
}

/**
 * API для плеера: быстро отдать список аудиодорожек до запуска HLS.
 */
function media_info_endpoint(string $hlsRoot): void {
    $url=req('url');
    if($url==='')json(['ok'=>false,'error'=>'url required'],400);
    if(!preg_match('#^https?://#i',$url))json(['ok'=>false,'error'=>'Only http/https stream URLs are supported'],400);
    $nu=norm_url($url);
    $dir=session_dir($hlsRoot,'probe_'.substr(sha1($nu),0,16));
    ensure_dir($dir);
    touch_session($dir);
    $mi=media_info($nu,$dir);
    json([
        'ok'=>true,
        'api_version'=>API_VERSION,
        'source_url'=>$url,
        'normalized_url'=>$nu,
        'duration'=>(float)($mi['duration']??0),
        'video_codec'=>(string)($mi['video_codec']??''),
        'audio_codec'=>(string)($mi['audio_codec']??''),
        'audio_channels'=>(int)($mi['audio_channels']??0),
        'audio_tracks'=>is_array($mi['audio_tracks']??null)?$mi['audio_tracks']:[],
        'subtitle_tracks'=>is_array($mi['subtitle_tracks']??null)?$mi['subtitle_tracks']:[],
    ]);
}

/**
 * Возвращает параметры ffmpeg для совместимого AAC-аудио.
 */
function audio_browser_args(string $bitrate='160k', bool $resetPts=true): array {
    /*
     * For browser HLS we want plain AAC-LC stereo 48 kHz.
     * In sync-safe modes both video and audio are regenerated from the same
     * input timeline, so resetting audio PTS is safe and helps avoid drift.
     */
    $filter = $resetPts ? 'aresample=async=1000:first_pts=0' : 'aresample=async=1000';
    return ['-c:a aac','-profile:a aac_low','-b:a '.escapeshellarg($bitrate),'-ac 2','-ar 48000','-af '.escapeshellarg($filter)];
}

/**
 * Возвращает параметры ffmpeg для sync-safe H.264 видео.
 */
function video_syncsafe_args(int $width, string $preset, string $crf, string $threads): array {
    /*
     * This is intentionally a real video encode, not stream copy.
     * Copying video while rebuilding audio is cheap, but on many torrent files
     * it keeps broken/non-zero video DTS/PTS while audio gets a fresh timeline.
     * Chrome+hls.js then shows visible A/V desync. setpts forces video and audio
     * to start from the same clean browser timeline.
     */
    return [
        '-c:v libx264',
        '-preset '.escapeshellarg($preset),
        '-crf '.escapeshellarg($crf),
        '-threads '.escapeshellarg($threads),
        '-pix_fmt yuv420p',
        '-vf '.escapeshellarg("setpts=PTS-STARTPTS,scale='min($width,iw)':-2"),
        '-tune fastdecode',
        '-x264-params '.escapeshellarg('keyint=48:min-keyint=48:scenecut=0')
    ];
}

/**
 * Выбирает профиль кодирования по качеству и параметрам исходника.
 */
function encoding(array $m,string $quality): array {
    $vc=$m['video_codec']??'';
    $pix=$m['video_pix_fmt']??'';

    $safeH264 = $vc === 'h264'
        && $pix !== ''
        && !str_contains($pix, '10')
        && !str_contains($pix, '12');

    /*
     * quality=copy is kept only as an explicit emergency/debug mode.
     * It is low CPU, but it is exactly the class of mode that can desync.
     * The plugin sends quality=fast, so normal playback uses sync-safe below.
     */
    if($quality === 'copy' && $safeH264){
        return [
            'name'=>'copy_video_fmp4_safe_audio_debug',
            'description'=>'debug only: copy H.264 video, transcode audio to AAC-LC; may desync on bad timestamps',
            'video_args'=>['-c:v copy'],
            'audio_args'=>audio_browser_args('128k', false),
            'segment_type'=>'fmp4',
            'preserve_timestamps'=>false,
            'cpu_level'=>'very_low_desync_risk'
        ];
    }

    /*
     * Default fast mode is now sync-safe, not stream-copy.
     * It costs more than pure remux, but much less than the previous universal
     * 720p/veryfast encode: 1 thread, ultrafast, moderate width cap.
     */
    if($quality==='lowcpu'){
        $w=854; $preset='ultrafast'; $crf='31'; $thr='1'; $ab='112k'; $cpu='low_controlled';
    } elseif($quality==='balanced'){
        $w=1280; $preset='veryfast'; $crf='25'; $thr='2'; $ab='160k'; $cpu='medium';
    } elseif($quality==='safe'){
        $w=1280; $preset='veryfast'; $crf='24'; $thr='2'; $ab='160k'; $cpu='safe_medium';
    } elseif($quality==='ultra'){
        // Very high quality: CRF 18, up to FullHD, never upscale above source width.
        $w=1920; $preset='veryfast'; $crf='18'; $thr='2'; $ab='192k'; $cpu='ultra_high_quality_heavy';
    } else {
        // fast: good default for 2 CPU cores. For many 720p anime files this keeps acceptable quality.
        $w=960; $preset='ultrafast'; $crf='29'; $thr='1'; $ab='128k'; $cpu='syncsafe_low_medium';
    }

    $profileName = $quality === 'ultra' ? 'ultra_quality_fmp4' : ($quality === 'safe' ? 'safe_full_transcode_fmp4' : 'syncsafe_fmp4');

    return [
        'name'=>$profileName,
        'description'=>'sync-safe H.264/AAC-LC fMP4: regenerate video/audio timestamps together to prevent A/V desync',
        'video_args'=>video_syncsafe_args($w, $preset, $crf, $thr),
        'audio_args'=>audio_browser_args($ab, true),
        'segment_type'=>'fmp4',
        'preserve_timestamps'=>false,
        'cpu_level'=>$cpu,
        'source_video_was_browser_safe_h264'=>$safeH264
    ];
}

/**
 * Запускает временную HLS-сессию для онлайн-просмотра.
 */
function start_hls(string $root): void {
    $url=g('url');
    if($url==='')json(['ok'=>false,'error'=>'url required'],400);

    $cid=g('content_id','stream_'.substr(sha1($url),0,12));
    $sid=sid(g('sid',$cid)) ?: ('sid_'.substr(sha1($url),0,16));
    $quality=g('quality','fast');
    $start=max(0,(float)g('start','0'));
    $force=g('force','0')==='1';
    $audioTrack=max(0,(int)g('audio_track','0'));
    $nu=norm_url($url);
    $dir=session_dir($root,$sid);
    ensure_dir($dir);

    $pidFile="$dir/ffmpeg.pid";
    $pid=is_file($pidFile)?(int)trim((string)file_get_contents($pidFile)):0;
    $run=running($pid);
    $oldUrl=is_file("$dir/source_url.txt")?trim((string)file_get_contents("$dir/source_url.txt")):'';
    $oldStart=is_file("$dir/offset.txt")?(float)trim((string)file_get_contents("$dir/offset.txt")):-1;
    $oldQuality=is_file("$dir/quality.txt")?trim((string)file_get_contents("$dir/quality.txt")):'';
    $oldApi=is_file("$dir/api_version.txt")?trim((string)file_get_contents("$dir/api_version.txt")):'';
    $oldAudio=is_file("$dir/audio_track.txt")?(int)trim((string)file_get_contents("$dir/audio_track.txt")):0;

    $ready=is_file("$dir/index.m3u8")&&filesize("$dir/index.m3u8")>0&&(count(glob("$dir/*.m4s")?:[])>0||count(glob("$dir/*.ts")?:[])>0);
    $restart=$force||$oldUrl!==$nu||abs($oldStart-$start)>1||$oldQuality!==$quality||$oldApi!==API_VERSION||$oldAudio!==$audioTrack||(!$run&&!$ready);

    if($restart){
        if($run)kill_pid($pid);
        rrmdir($dir);
        ensure_dir($dir);
        file_put_contents("$dir/source_url.txt",$nu);
        file_put_contents("$dir/offset.txt",(string)$start);
        file_put_contents("$dir/quality.txt",$quality);
        file_put_contents("$dir/audio_track.txt",(string)$audioTrack);
        file_put_contents("$dir/api_version.txt",API_VERSION);
        touch_session($dir);

        $mi=media_info($nu,$dir);
        $audioTrack=normalize_audio_track($mi,$audioTrack);
        file_put_contents("$dir/audio_track.txt",(string)$audioTrack);
        $enc=encoding($mi,$quality);
        write_json("$dir/encoding.json",$enc);

        $headers=lampa_sync_ffmpeg_headers();
        $parts=[
            escapeshellarg(FFMPEG_BIN),
            '-y',
            '-hide_banner',
            '-nostdin',
            '-loglevel info',
            '-rw_timeout 600000000',
            '-reconnect 1',
            '-reconnect_streamed 1',
            '-reconnect_on_network_error 1',
            '-reconnect_on_http_error 4xx,5xx',
            '-reconnect_delay_max 30',
            '-fflags +genpts+igndts',
            '-avoid_negative_ts make_zero',
            '-analyzeduration 50M',
            '-probesize 50M',
            '-headers '.escapeshellarg($headers)
        ];

        if($start>0)$parts[]='-ss '.escapeshellarg((string)$start);
        $parts[]='-i '.escapeshellarg($nu);
        array_push($parts,'-map 0:v:0','-map 0:a:'.$audioTrack.'?','-sn','-dn');
        foreach($enc['video_args'] as $a)$parts[]=$a;
        foreach($enc['audio_args'] as $a)$parts[]=$a;

        array_push(
            $parts,
            '-max_muxing_queue_size 4096',
            '-max_interleave_delta 0',
            '-muxdelay 0',
            '-muxpreload 0',
            '-f hls',
            '-hls_time 4',
            '-hls_list_size 0',
            '-hls_flags independent_segments',
            '-hls_segment_type fmp4',
            '-hls_fmp4_init_filename '.escapeshellarg('init.mp4'),
            '-hls_segment_filename '.escapeshellarg("$dir/seg_%05d.m4s"),
            escapeshellarg("$dir/index.m3u8")
        );

        $cmd='nice -n 10 '.implode(' ',$parts).' > '.escapeshellarg("$dir/ffmpeg.log").' 2>&1 & echo $!';
        file_put_contents("$dir/ffmpeg_cmd.txt",$cmd);
        $out=[];
        @exec($cmd,$out);
        file_put_contents($pidFile,(string)((int)($out[0]??0)));
    } else touch_session($dir);

    hls_status($root,$sid);
}

/**
 * Считает длительность HLS-плейлиста по EXTINF-сегментам.
 */
function playlist_seconds(string $f): float { if(!is_file($f))return 0; preg_match_all('~#EXTINF:([0-9.]+)~',(string)file_get_contents($f),$m); $s=0; foreach($m[1]??[] as $v)$s+=(float)$v; return $s; }
/**
 * Проверяет, завершён ли HLS-плейлист тегом EXT-X-ENDLIST.
 */
function playlist_has_endlist(string $f): bool { return is_file($f) && stripos((string)file_get_contents($f), '#EXT-X-ENDLIST') !== false; }
/**
 * Берёт duration из media_info.json, если он уже известен.
 */
function duration_from_media_cache(string $dir): float {
    $f = rtrim($dir, '/') . '/media_info.json';
    if (!is_file($f) || filesize($f) <= 0) return 0.0;
    $j = json_decode((string)file_get_contents($f), true);
    if (!is_array($j)) return 0.0;
    $d = (float)($j['duration'] ?? 0);
    return $d > 0 ? $d : 0.0;
}
/**
 * Вытаскивает duration из ffmpeg.log, если ffprobe не смог определить длительность.
 */
function duration_from_ffmpeg_log(string $f): float {
    if (!is_file($f) || filesize($f) <= 0) return 0.0;
    $log = tail_file($f, 12000);
    if (preg_match('~Duration:\s*(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)~', $log, $m)) {
        return ((int)$m[1]) * 3600 + ((int)$m[2]) * 60 + (float)$m[3];
    }
    return 0.0;
}
/**
 * Возвращает статус временной HLS-сессии для player.html.
 */
function hls_status(string $root,?string $forced=null): void {
    $sid=sid($forced ?: g('sid'));
    if($sid==='')json(['ok'=>false,'error'=>'sid required'],400);
    $dir=session_dir($root,$sid);
    touch_session($dir);
    $pid=is_file("$dir/ffmpeg.pid")?(int)trim((string)file_get_contents("$dir/ffmpeg.pid")):0;
    $run=running($pid);
    $segments=is_dir($dir)?(count(glob("$dir/*.m4s")?:[])+count(glob("$dir/*.ts")?:[])):0;
    $pl="$dir/index.m3u8";
    $plExists=is_file($pl);
    $plSize=$plExists?(int)filesize($pl):0;
    $ready=$plExists&&$plSize>0&&$segments>0;
    $offset=is_file("$dir/offset.txt")?(float)trim((string)file_get_contents("$dir/offset.txt")):0;
    $prep=playlist_seconds($pl);
    $mi=read_json("$dir/media_info.json");
    $enc=read_json("$dir/encoding.json");
    $src=is_file("$dir/source_url.txt")?trim((string)file_get_contents("$dir/source_url.txt")):'';
    json(['ok'=>true,'api_version'=>API_VERSION,'sid'=>$sid,'running'=>$run,'ready'=>$ready,'playlist_exists'=>$plExists,'playlist_size'=>$plSize,'segments'=>$segments,'offset'=>$offset,'duration'=>(float)($mi['duration']??0),'prepared_seconds'=>$prep,'prepared_until'=>$offset+$prep,'source_url'=>$src,'audio_track'=>(int)(is_file("$dir/audio_track.txt")?trim((string)file_get_contents("$dir/audio_track.txt")):0),'audio_tracks'=>is_array($mi['audio_tracks']??null)?$mi['audio_tracks']:[],'subtitle_tracks'=>is_array($mi['subtitle_tracks']??null)?$mi['subtitle_tracks']:[],'contains_preload'=>str_contains($src,'preload'),'contains_play'=>str_contains($src,'play'),'encoding'=>$enc,'media'=>['video_codec'=>$mi['video_codec']??'','video_pix_fmt'=>$mi['video_pix_fmt']??'','video_width'=>$mi['video_width']??0,'video_height'=>$mi['video_height']??0,'audio_codec'=>$mi['audio_codec']??'','audio_channels'=>$mi['audio_channels']??0,'audio_tracks'=>is_array($mi['audio_tracks']??null)?$mi['audio_tracks']:[],'subtitle_tracks'=>is_array($mi['subtitle_tracks']??null)?$mi['subtitle_tracks']:[]],'last_log'=>tail_file("$dir/ffmpeg.log",4000),'hls_url'=>lampa_sync_api_url(['hls'=>'1','sid'=>$sid,'file'=>'index.m3u8'])]);
}

/**
 * Останавливает временную HLS-сессию и при необходимости удаляет её файлы.
 */
function stop_hls(string $root): void { $sid=sid(g('sid')); if($sid==='')json(['ok'=>false,'error'=>'sid required'],400); $dir=session_dir($root,$sid); $pid=is_file("$dir/ffmpeg.pid")?(int)trim((string)file_get_contents("$dir/ffmpeg.pid")):0; if($pid>0&&running($pid))kill_pid($pid); if(is_dir($dir)){file_put_contents("$dir/stopped.txt",(string)time());touch_session($dir);} $delete=g('delete','1')!=='0'; if($delete)rrmdir($dir); json(['ok'=>true,'sid'=>$sid,'killed_pid'=>$pid,'deleted'=>$delete]); }
/**
 * Отдаёт временные HLS-файлы из data/hls.
 */
function serve_hls(string $root): void {
    $sid=sid(g('sid'));
    $file=g('file','index.m3u8');
    if($sid===''){http_response_code(400);echo'sid required';exit;}
    if(!preg_match('~^[a-zA-Z0-9_.-]+$~',$file)){http_response_code(400);echo'invalid file';exit;}

    $dir=session_dir($root,$sid);
    touch_session($dir);
    $path="$dir/$file";
    if(!is_file($path)){http_response_code(404);echo'file not found';exit;}

    if(str_ends_with($file,'.m3u8')){
        header('Content-Type: application/vnd.apple.mpegurl');
        header('Cache-Control: no-cache, no-store, must-revalidate');
        header('Pragma: no-cache');
        $lines=preg_split('~\r\n|\r|\n~',(string)file_get_contents($path));
        $out=[];
        foreach($lines as $line){
            $t=trim((string)$line);
            if(str_starts_with($t,'#EXT-X-MAP:') && preg_match('~URI="([^"]+)"~',$t,$m) && preg_match('~^[a-zA-Z0-9_.-]+\.mp4$~',$m[1])){
                $u=lampa_sync_api_url(['hls'=>'1','sid'=>$sid,'file'=>$m[1]]);
                $out[]=preg_replace('~URI="([^"]+)"~','URI="'.$u.'"',$line);
            } elseif($t!==''&&$t[0]!=='#'&&preg_match('~^[a-zA-Z0-9_.-]+\.(ts|m4s|mp4)$~',$t)){
                $out[]=lampa_sync_api_url(['hls'=>'1','sid'=>$sid,'file'=>$t]);
            } else $out[]=$line;
        }
        echo implode("\n",$out);
        exit;
    }

    if(str_ends_with($file,'.ts')){
        header('Content-Type: video/mp2t');
        header('Cache-Control: no-store');
        header('Content-Length: '.filesize($path));
        readfile($path);
        exit;
    }

    if(str_ends_with($file,'.m4s')){
        header('Content-Type: video/iso.segment');
        header('Cache-Control: no-store');
        header('Content-Length: '.filesize($path));
        readfile($path);
        exit;
    }

    if(str_ends_with($file,'.mp4')){
        header('Content-Type: video/mp4');
        header('Cache-Control: no-store');
        header('Content-Length: '.filesize($path));
        readfile($path);
        exit;
    }

    http_response_code(403);echo'forbidden';exit;
}

/**
 * Создаёт старую таблицу прогресса просмотра для совместимости.
 */
function pdo_db(string $dir): PDO { if(!extension_loaded('pdo_sqlite'))throw new RuntimeException('pdo_sqlite not installed'); if(!is_writable($dir))throw new RuntimeException('data dir not writable: '.$dir); $pdo=new PDO('sqlite:'.$dir.'/progress.sqlite'); $pdo->setAttribute(PDO::ATTR_ERRMODE,PDO::ERRMODE_EXCEPTION); $pdo->exec('PRAGMA journal_mode = WAL'); $pdo->exec('PRAGMA busy_timeout = 5000'); $pdo->exec('CREATE TABLE IF NOT EXISTS progress (content_id TEXT PRIMARY KEY,title TEXT,url TEXT,position REAL DEFAULT 0,duration REAL DEFAULT 0,percent INTEGER DEFAULT 0,ended INTEGER DEFAULT 0,device_id TEXT,updated_at INTEGER DEFAULT 0,created_at INTEGER DEFAULT 0)'); return $pdo; }
/**
 * Мини-API прогресса текущего плеера; основной sync localStorage находится в progress.php.
 */
function progress_api(string $dir): void {
    $pdo = pdo_db($dir);

    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        $cid = trim((string)($_GET['content_id'] ?? ''));
        $ids = progress_ids_from_request($cid, (string)($_GET['content_ids'] ?? ''));

        if ($cid === '' && !$ids) {
            if (g('progress_debug') === '1') {
                $st = $pdo->query('SELECT content_id,title,position,duration,percent,ended,device_id,updated_at,created_at FROM progress ORDER BY updated_at DESC LIMIT 100');
                json(['ok'=>true,'api_version'=>API_VERSION,'items'=>$st->fetchAll(PDO::FETCH_ASSOC)]);
            }

            $st = $pdo->query('SELECT * FROM progress ORDER BY updated_at DESC');
            json($st->fetchAll(PDO::FETCH_ASSOC));
        }

        if (g('progress_debug') === '1') {
            $rows = progress_rows_by_ids($pdo, $ids);
            json([
                'ok'=>true,
                'api_version'=>API_VERSION,
                'requested_content_id'=>$cid,
                'requested_ids'=>$ids,
                'rows'=>$rows,
                'selected'=>select_best_progress_row($rows, $ids),
            ]);
        }

        $rows = progress_rows_by_ids($pdo, $ids);
        json(select_best_progress_row($rows, $ids));
    }

    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $raw = file_get_contents('php://input');
        $d = json_decode($raw, true);

        if (!is_array($d)) json(['error' => 'Invalid JSON', 'raw' => $raw], 400);

        $cid = trim((string)($d['content_id'] ?? ''));
        if ($cid === '') $cid = trim((string)($d['progress_content_id'] ?? ''));
        if ($cid === '') json(['error' => 'content_id required'], 400);

        $pos = max(0, (float)($d['position'] ?? 0));
        $dur = max(0, (float)($d['duration'] ?? 0));
        $pct = $dur > 0 ? (int)round(($pos / $dur) * 100) : 0;
        $ended = !empty($d['ended']) ? 1 : 0;
        $upd = (int)($d['updated_at'] ?? round(microtime(true) * 1000));
        $now = (int)round(microtime(true) * 1000);
        $device = (string)($d['device_id'] ?? '');

        $st = $pdo->prepare('SELECT * FROM progress WHERE content_id = :id LIMIT 1');
        $st->execute(['id' => $cid]);
        $old = $st->fetch(PDO::FETCH_ASSOC) ?: null;

        if ($old) {
            $oldPct = (int)($old['percent'] ?? 0);
            $oldPos = (float)($old['position'] ?? 0);
            $oldEnded = (int)($old['ended'] ?? 0);
            $oldDevice = (string)($old['device_id'] ?? '');
            $oldUpdated = (int)($old['updated_at'] ?? 0);

            /*
             * Защита от старых вкладок/устройств остаётся, но она больше не должна
             * блокировать нормальный просмотр того же устройства. Раньше общий
             * content_id мог заставить API считать новый фильм “откатом назад”.
             */
            $incomingBehind = $pct < $oldPct || ($pct === $oldPct && $pos < $oldPos - 3);
            $sameDevice = $device !== '' && $oldDevice !== '' && hash_equals($oldDevice, $device);

            if ($incomingBehind && !$ended && !$sameDevice && $oldEnded) {
                progress_log($dir, 'post_skip', ['content_id'=>$cid,'reason'=>'old_ended_progress_is_newer','pos'=>$pos,'old_pos'=>$oldPos,'device'=>$device,'old_device'=>$oldDevice]);
                json(['ok' => true, 'skipped' => true, 'reason' => 'old_ended_progress_is_newer']);
            }

            if ($incomingBehind && !$ended && !$sameDevice && ($now - $oldUpdated) < 15 * 60 * 1000) {
                progress_log($dir, 'post_skip', ['content_id'=>$cid,'reason'=>'incoming_progress_is_behind_recent_other_device','pos'=>$pos,'old_pos'=>$oldPos,'device'=>$device,'old_device'=>$oldDevice]);
                json(['ok' => true, 'skipped' => true, 'reason' => 'incoming_progress_is_behind_recent_other_device']);
            }

            if ($oldUpdated > $upd && !$ended && !$sameDevice && ($now - $oldUpdated) < 15 * 60 * 1000) {
                progress_log($dir, 'post_skip', ['content_id'=>$cid,'reason'=>'incoming_timestamp_is_older_recent_other_device','pos'=>$pos,'old_pos'=>$oldPos,'device'=>$device,'old_device'=>$oldDevice]);
                json(['ok' => true, 'skipped' => true, 'reason' => 'incoming_timestamp_is_older_recent_other_device']);
            }

            $st = $pdo->prepare('UPDATE progress SET title=:title,url=:url,position=:pos,duration=:dur,percent=:pct,ended=:ended,device_id=:dev,updated_at=:upd WHERE content_id=:id');
            $st->execute([
                'id' => $cid,
                'title' => (string)($d['title'] ?? ''),
                'url' => (string)($d['url'] ?? ''),
                'pos' => $pos,
                'dur' => $dur,
                'pct' => $pct,
                'ended' => $ended,
                'dev' => $device,
                'upd' => max($upd, $now),
            ]);
        } else {
            $st = $pdo->prepare('INSERT INTO progress (content_id,title,url,position,duration,percent,ended,device_id,updated_at,created_at) VALUES (:id,:title,:url,:pos,:dur,:pct,:ended,:dev,:upd,:created)');
            $st->execute([
                'id' => $cid,
                'title' => (string)($d['title'] ?? ''),
                'url' => (string)($d['url'] ?? ''),
                'pos' => $pos,
                'dur' => $dur,
                'pct' => $pct,
                'ended' => $ended,
                'dev' => $device,
                'upd' => max($upd, $now),
                'created' => $now,
            ]);
        }

        progress_log($dir, 'post_ok', ['content_id'=>$cid,'position'=>$pos,'duration'=>$dur,'percent'=>$pct,'ended'=>$ended,'device'=>$device]);
        json(['ok' => true, 'content_id' => $cid, 'position' => $pos, 'duration' => $dur, 'percent' => $pct]);
    }

    json(['error' => 'Method not allowed'], 405);
}

function progress_ids_from_request(string $cid, string $idsRaw): array {
    $ids = [];

    if ($cid !== '') $ids[] = $cid;

    if ($idsRaw !== '') {
        foreach (explode(',', $idsRaw) as $id) {
            $id = trim((string)$id);
            if ($id !== '') $ids[] = $id;
        }
    }

    $out = [];
    foreach ($ids as $id) {
        $id = trim((string)$id);
        if ($id === '' || in_array($id, $out, true)) continue;
        $out[] = $id;
    }

    return array_slice($out, 0, 20);
}

function progress_rows_by_ids(PDO $pdo, array $ids): array {
    if (!$ids) return [];

    $ph = [];
    $params = [];
    foreach ($ids as $i => $id) {
        $k = ':id' . $i;
        $ph[] = $k;
        $params[$k] = $id;
    }

    $st = $pdo->prepare('SELECT * FROM progress WHERE content_id IN (' . implode(',', $ph) . ')');
    $st->execute($params);
    return $st->fetchAll(PDO::FETCH_ASSOC) ?: [];
}

function select_best_progress_row(array $rows, array $ids): ?array {
    if (!$rows) return null;

    $priority = [];
    foreach ($ids as $i => $id) $priority[$id] = $i;

    usort($rows, function(array $a, array $b) use ($priority): int {
        $pa = $priority[(string)($a['content_id'] ?? '')] ?? 9999;
        $pb = $priority[(string)($b['content_id'] ?? '')] ?? 9999;

        if ($pa !== $pb) return $pa <=> $pb;

        $ua = (int)($a['updated_at'] ?? 0);
        $ub = (int)($b['updated_at'] ?? 0);
        return $ub <=> $ua;
    });

    return $rows[0] ?: null;
}

function progress_log(string $dir, string $event, array $data=[]): void {
    @file_put_contents($dir . '/progress_api.log', json_encode(['time'=>date('c'), 'event'=>$event] + $data, JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES) . "\n", FILE_APPEND);
}