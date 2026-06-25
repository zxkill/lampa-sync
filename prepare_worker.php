<?php
declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('log_errors', '1');

// Worker использует тот же config.php, что и web API.
require_once __DIR__ . '/bootstrap.php';

if (!defined('API_VERSION')) define('API_VERSION', 'v1.0.9-ultra-quality-preset');

$DATA_DIR = LAMPA_SYNC_DATA_DIR;
$PREPARED_DIR = $DATA_DIR . '/prepared';
$DB_FILE = $DATA_DIR . '/prepare_queue.sqlite';
$LOCK_FILE = $DATA_DIR . '/prepare_worker.lock';
$LOCK_HANDLE = null;
$LOCK_STARTED_AT = now_ms();

@mkdir($DATA_DIR, 0777, true);
@mkdir($PREPARED_DIR, 0777, true);
ini_set('error_log', $DATA_DIR . '/prepare_worker_error.log');


// Режим watchdog запускается из cron и безопасно проверяет/поднимает очередь.
$argv = $argv ?? [];
$WATCHDOG_MODE = in_array('--watchdog', $argv, true);
worker_log('start', ['version'=>API_VERSION, 'sapi'=>PHP_SAPI, 'php'=>PHP_BINARY, 'pid'=>getmypid(), 'watchdog'=>$WATCHDOG_MODE]);

$LOCK_HANDLE = acquire_worker_lock($LOCK_FILE);
if (!$LOCK_HANDLE) {
    worker_log('already_running', ['lock'=>$LOCK_FILE]);
    exit;
}

try {
    $pdo = prepare_db($DB_FILE);
    $recovered = recover_stale_jobs($pdo, $PREPARED_DIR);
    if ($recovered) worker_log('stale_recovered', ['items'=>$recovered]);

    $processed = 0;

    while (true) {
        lock_heartbeat($LOCK_HANDLE);
        $job = next_job($pdo);
        if (!$job) break;

        $processed++;
        worker_log('job_start', [
            'id'=>(int)$job['id'],
            'content_id'=>(string)$job['content_id'],
            'title'=>(string)$job['title'],
            'attempts'=>(int)$job['attempts'],
            'max_attempts'=>(int)$job['max_attempts'],
        ]);

        process_job($pdo, $job, $PREPARED_DIR);
        worker_log('job_finished_iteration', ['id'=>(int)$job['id']]);
    }

    worker_log('finish', ['processed'=>$processed, 'watchdog'=>$WATCHDOG_MODE]);
} catch (Throwable $e) {
    worker_log('fatal', ['message'=>$e->getMessage(), 'file'=>$e->getFile(), 'line'=>$e->getLine()]);
    error_log($e->getMessage() . "\n" . $e->getTraceAsString());
} finally {
    if (is_resource($LOCK_HANDLE)) {
        @ftruncate($LOCK_HANDLE, 0);
        @flock($LOCK_HANDLE, LOCK_UN);
        @fclose($LOCK_HANDLE);
    }
}

/**
 * Пишет структурированный JSON-лог worker-а в data/prepare_worker_runtime.log.
 */
function worker_log(string $event, array $data=[]): void {
    global $DATA_DIR;
    @mkdir($DATA_DIR, 0777, true);
    $row = ['time'=>date('c'), 'event'=>$event] + $data;
    @file_put_contents($DATA_DIR . '/prepare_worker_runtime.log', json_encode($row, JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES) . "\n", FILE_APPEND);
}

/**
 * Берёт эксклюзивный lock, чтобы не запустить две конвертации одновременно.
 */
function acquire_worker_lock(string $lockFile) {
    $lock = fopen($lockFile, 'c+');
    if (!$lock) {
        worker_log('lock_open_failed', ['lock'=>$lockFile]);
        return null;
    }

    if (@flock($lock, LOCK_EX | LOCK_NB)) {
        lock_heartbeat($lock);
        return $lock;
    }

    $meta = read_json($lockFile);
    $pid = (int)($meta['pid'] ?? 0);
    $heartbeat = (int)($meta['heartbeat_at'] ?? 0);
    $age = $heartbeat > 0 ? now_ms() - $heartbeat : null;

    if ($pid > 0 && $age !== null && $age > WORKER_HEARTBEAT_STALE_MS) {
        worker_log('stale_lock_detected', ['pid'=>$pid, 'heartbeat_age_sec'=>round($age / 1000)]);
        kill_pid($pid);
        usleep(500000);

        for ($i = 0; $i < 5; $i++) {
            if (@flock($lock, LOCK_EX | LOCK_NB)) {
                lock_heartbeat($lock);
                worker_log('stale_lock_recovered', ['old_pid'=>$pid]);
                return $lock;
            }
            usleep(300000);
        }
    }

    fclose($lock);
    return null;
}

/**
 * Обновляет heartbeat внутри lock-файла, чтобы watchdog видел живой worker.
 */
function lock_heartbeat($lock): void {
    global $LOCK_STARTED_AT;
    if (!is_resource($lock)) return;
    $payload = [
        'pid'=>getmypid(),
        'started_at'=>$LOCK_STARTED_AT,
        'heartbeat_at'=>now_ms(),
        'version'=>API_VERSION,
    ];
    @ftruncate($lock, 0);
    @rewind($lock);
    @fwrite($lock, json_encode($payload, JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES));
    @fflush($lock);
}

/**
 * Создаёт/мигрирует SQLite-таблицу очереди со служебными полями worker-а.
 */
function prepare_db(string $dbFile): PDO {
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
        if (!isset($cols[$name])) $pdo->exec('ALTER TABLE prepare_queue ADD COLUMN ' . $name . ' ' . $sql);
    }
    $pdo->exec('CREATE INDEX IF NOT EXISTS ix_prepare_queue_status ON prepare_queue(status, updated_at)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS ix_prepare_queue_retry ON prepare_queue(status, next_retry_at)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS ix_prepare_queue_torrent ON prepare_queue(torrent_hash, file_index, audio_track)');
    return $pdo;
}

/**
 * Находит зависшие processing-задачи и возвращает их в retry/error.
 */
function recover_stale_jobs(PDO $pdo, string $preparedRoot): array {
    $now = now_ms();
    $rows = $pdo->query("SELECT * FROM prepare_queue WHERE status='processing'")->fetchAll(PDO::FETCH_ASSOC) ?: [];
    $changed = [];

    foreach ($rows as $row) {
        $id = (int)$row['id'];
        $pid = (int)($row['pid'] ?? 0);
        $workerPid = (int)($row['worker_pid'] ?? 0);
        $heartbeat = (int)($row['last_heartbeat_at'] ?? 0);
        $heartbeatStale = $heartbeat <= 0 || ($now - $heartbeat) > WORKER_HEARTBEAT_STALE_MS;
        $processGone = ($workerPid > 0 && !running($workerPid)) && ($pid <= 0 || !running($pid));

        if (!$heartbeatStale && !$processGone) continue;

        if ($pid > 0 && running($pid)) kill_pid($pid);
        if ($workerPid > 0 && $workerPid !== getmypid() && running($workerPid)) kill_pid($workerPid);
        rrmdir(session_dir($preparedRoot, (string)$row['prepare_key']));

        fail_job($pdo, $row, 'Watchdog: previous worker/ffmpeg stalled or died', true);
        $changed[] = ['id'=>$id, 'content_id'=>(string)$row['content_id']];
    }

    return $changed;
}

/**
 * Берёт следующую задачу queued/retry, которую уже можно обрабатывать.
 */
function next_job(PDO $pdo): ?array {
    $now = now_ms();
    $pdo->beginTransaction();
    $st = $pdo->prepare("SELECT * FROM prepare_queue
        WHERE cancel_requested=0
          AND attempts < max_attempts
          AND (status='queued' OR (status='retry' AND next_retry_at<=:now))
        ORDER BY created_at ASC
        LIMIT 1");
    $st->execute(['now'=>$now]);
    $row = $st->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        $pdo->commit();
        return null;
    }

    $newAttempts = (int)($row['attempts'] ?? 0) + 1;
    $st = $pdo->prepare("UPDATE prepare_queue
        SET status='processing',progress=0,pid=0,worker_pid=:worker_pid,attempts=:attempts,error='',next_retry_at=0,last_heartbeat_at=:heartbeat,last_progress_at=:progress_at,started_at=:started,updated_at=:updated,finished_at=0
        WHERE id=:id AND (status='queued' OR status='retry')");
    $st->execute([
        'worker_pid'=>getmypid(),
        'attempts'=>$newAttempts,
        'heartbeat'=>$now,
        'progress_at'=>$now,
        'started'=>$now,
        'updated'=>$now,
        'id'=>(int)$row['id'],
    ]);
    $pdo->commit();

    $row['status'] = 'processing';
    $row['worker_pid'] = getmypid();
    $row['attempts'] = $newAttempts;
    $row['started_at'] = $now;
    $row['updated_at'] = $now;
    $row['last_heartbeat_at'] = $now;
    $row['last_progress_at'] = $now;
    return $row;
}

/**
 * Основной цикл обработки одной задачи: ffprobe, ffmpeg, прогресс, готовность.
 */
function process_job(PDO $pdo, array $job, string $preparedRoot): void {
    $id = (int)$job['id'];
    $key = (string)$job['prepare_key'];
    $url = (string)($job['normalized_url'] ?: $job['source_url']);
    $quality = (string)($job['quality'] ?: 'fast');
    $audioTrack = max(0, (int)($job['audio_track'] ?? 0));
    $dir = session_dir($preparedRoot, $key);

    rrmdir($dir);
    ensure_dir($dir);

    file_put_contents("$dir/source_url.txt", $url);
    file_put_contents("$dir/source_mode.txt", 'background_prepare_from_start');
    file_put_contents("$dir/offset.txt", '0');
    file_put_contents("$dir/quality.txt", $quality);
    file_put_contents("$dir/audio_track.txt", (string)$audioTrack);
    file_put_contents("$dir/api_version.txt", API_VERSION);
    file_put_contents("$dir/content_id.txt", (string)$job['content_id']);

    try {
        heartbeat_job($pdo, $id, 0, 0, 0, 0, true);
        worker_log('media_probe_start', ['id'=>$id, 'url'=>$url, 'mode'=>'background_prepare_from_start']);
        $mi = media_info($url, $dir);
        $audioTrack = normalize_audio_track($mi, $audioTrack);
        file_put_contents("$dir/audio_track.txt", (string)$audioTrack);
        update_job($pdo, $id, ['audio_track'=>$audioTrack]);
        worker_log('media_probe_done', ['id'=>$id, 'duration'=>(float)($mi['duration'] ?? 0), 'video_codec'=>(string)($mi['video_codec'] ?? ''), 'audio_codec'=>(string)($mi['audio_codec'] ?? ''), 'audio_track'=>$audioTrack]);

        $duration = (float)($mi['duration'] ?? 0);
        update_job($pdo, $id, ['duration'=>$duration, 'updated_at'=>now_ms(), 'last_heartbeat_at'=>now_ms(), 'worker_pid'=>getmypid()]);
        $enc = encoding($mi, $quality);
        write_json("$dir/media_info.json", $mi);
        write_json("$dir/encoding.json", $enc);

        $headers = lampa_sync_ffmpeg_headers();
        $parts = [
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
            '-headers '.escapeshellarg($headers),
            '-i '.escapeshellarg($url),
            '-map 0:v:0',
            '-map 0:a:'.$audioTrack.'?',
            '-sn',
            '-dn'
        ];
        foreach ($enc['video_args'] as $a) $parts[] = $a;
        foreach ($enc['audio_args'] as $a) $parts[] = $a;
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

        $cmd = 'nice -n 12 ' . implode(' ', $parts) . ' > ' . escapeshellarg("$dir/ffmpeg.log") . ' 2>&1 & echo $!';
        file_put_contents("$dir/ffmpeg_cmd.txt", $cmd);
        $out = [];
        worker_log('ffmpeg_start', ['id'=>$id, 'cmd_file'=>"$dir/ffmpeg_cmd.txt"]);
        @exec($cmd, $out);
        $pid = (int)($out[0] ?? 0);
        worker_log('ffmpeg_spawned', ['id'=>$id, 'pid'=>$pid, 'out'=>$out]);
        if ($pid <= 0) throw new RuntimeException('ffmpeg process was not started');

        file_put_contents("$dir/ffmpeg.pid", (string)$pid);
        update_job($pdo, $id, ['pid'=>$pid, 'worker_pid'=>getmypid(), 'updated_at'=>now_ms(), 'last_heartbeat_at'=>now_ms()]);

        $lastPrepared = -1.0;
        $lastSegments = -1;
        $lastProgressAt = now_ms();

        while ($pid > 0 && running($pid)) {
            [$preparedNow, $segmentsNow] = refresh_progress($pdo, $id, $dir, $duration, $pid, $lastProgressAt);

            if (abs($preparedNow - $lastPrepared) >= 1 || $segmentsNow !== $lastSegments) {
                $lastPrepared = $preparedNow;
                $lastSegments = $segmentsNow;
                $lastProgressAt = now_ms();
            }

            if (now_ms() - $lastProgressAt > FFMPEG_NO_PROGRESS_STALE_MS) {
                worker_log('ffmpeg_no_progress_timeout', ['id'=>$id, 'pid'=>$pid, 'prepared_seconds'=>$preparedNow, 'segments'=>$segmentsNow]);
                kill_pid($pid);
                throw new RuntimeException('ffmpeg produced no new HLS progress for '.round(FFMPEG_NO_PROGRESS_STALE_MS / 60000).' minutes');
            }

            sleep(3);
        }

        refresh_progress($pdo, $id, $dir, $duration, $pid, $lastProgressAt);
        $segments = segment_count($dir);
        $playlist = "$dir/index.m3u8";
        $preparedSeconds = playlist_seconds($playlist);
        $hasEndList = playlist_has_endlist($playlist);
        $log = tail_file("$dir/ffmpeg.log", 12000);
        if ($duration <= 0) {
            $fromLog = duration_from_ffmpeg_log("$dir/ffmpeg.log");
            if ($fromLog > 0) {
                $duration = $fromLog;
                update_job($pdo, $id, ['duration'=>$duration, 'updated_at'=>now_ms()]);
            }
        }
        $finished = now_ms();
        $enoughDuration = $duration > 0 ? ($preparedSeconds >= max(1, $duration - 8)) : ($segments > 0);
        $ready = is_file($playlist) && filesize($playlist) > 0 && $segments > 0 && $hasEndList && $enoughDuration && !ffmpeg_log_has_error($log);

        worker_log('ffmpeg_finished', [
            'id'=>$id,
            'ready'=>$ready,
            'segments'=>$segments,
            'prepared_seconds'=>$preparedSeconds,
            'duration'=>$duration,
            'has_endlist'=>$hasEndList,
            'enough_duration'=>$enoughDuration,
            'log_error'=>ffmpeg_log_has_error($log)
        ]);

        if ($ready) {
            update_job($pdo, $id, [
                'status'=>'ready',
                'progress'=>100,
                'prepared_seconds'=>$preparedSeconds,
                'segments'=>$segments,
                'pid'=>0,
                'worker_pid'=>0,
                'error'=>'',
                'last_heartbeat_at'=>0,
                'updated_at'=>$finished,
                'finished_at'=>$finished,
            ]);
            worker_log('job_ready', ['id'=>$id]);
        } else {
            $reason = 'ffmpeg stopped before full HLS was prepared';
            if (!$hasEndList) $reason .= '; playlist has no EXT-X-ENDLIST';
            if ($duration > 0 && !$enoughDuration) $reason .= '; prepared '.round($preparedSeconds,1).'s of '.round($duration,1).'s';
            if (ffmpeg_log_has_error($log)) $reason .= '; ffmpeg log contains transport/conversion errors';
            fail_job($pdo, $job, $reason."\n\n".($log ?: 'empty ffmpeg log'), true, $preparedSeconds, $segments, $duration);
        }
    } catch (Throwable $e) {
        error_log($e->getMessage() . "\n" . $e->getTraceAsString());
        fail_job($pdo, $job, $e->getMessage(), true);
    }
}

/**
 * Переводит задачу в retry или error с сохранением причины.
 */
function fail_job(PDO $pdo, array $job, string $error, bool $retryAllowed, float $preparedSeconds=0, int $segments=0, float $duration=0): void {
    $now = now_ms();
    $id = (int)$job['id'];
    $attempts = (int)($job['attempts'] ?? 0);
    $maxAttempts = max(1, (int)($job['max_attempts'] ?? 3));
    $canRetry = $retryAllowed && $attempts < $maxAttempts && (int)($job['cancel_requested'] ?? 0) === 0;
    $status = $canRetry ? 'retry' : 'error';
    $nextRetryAt = $canRetry ? $now + retry_delay_ms($attempts) : 0;
    $progress = ($duration > 0 && $preparedSeconds > 0) ? min(99, round($preparedSeconds / $duration * 100, 1)) : 0;

    update_job($pdo, $id, [
        'status'=>$status,
        'progress'=>$progress,
        'prepared_seconds'=>$preparedSeconds,
        'segments'=>$segments,
        'pid'=>0,
        'worker_pid'=>0,
        'error'=>substr($error, -5000),
        'next_retry_at'=>$nextRetryAt,
        'last_heartbeat_at'=>0,
        'updated_at'=>$now,
        'finished_at'=>$status === 'error' ? $now : 0,
    ]);

    worker_log('job_failed', ['id'=>$id, 'status'=>$status, 'attempts'=>$attempts, 'max_attempts'=>$maxAttempts, 'next_retry_at'=>$nextRetryAt, 'error'=>substr($error, 0, 240)]);
}

/**
 * Считает задержку перед следующей попыткой обработки.
 */
function retry_delay_ms(int $attempts): int {
    if ($attempts <= 1) return 5 * 60 * 1000;
    if ($attempts === 2) return 15 * 60 * 1000;
    return 30 * 60 * 1000;
}

/**
 * Обновляет heartbeat/progress задачи во время работы ffmpeg.
 */
function heartbeat_job(PDO $pdo, int $id, float $prepared, int $segments, float $duration, int $pid, bool $forceProgress=false): void {
    global $LOCK_HANDLE;
    lock_heartbeat($LOCK_HANDLE);
    $now = now_ms();
    $data = [
        'pid'=>$pid,
        'worker_pid'=>getmypid(),
        'last_heartbeat_at'=>$now,
        'updated_at'=>$now,
    ];
    if ($forceProgress) $data['last_progress_at'] = $now;
    if ($prepared > 0 || $segments > 0 || $duration > 0) {
        $data['prepared_seconds'] = $prepared;
        $data['segments'] = $segments;
        $data['progress'] = $duration > 0 ? min(99, round($prepared / $duration * 100, 1)) : min(99, $segments);
        if ($forceProgress) $data['last_progress_at'] = $now;
    }
    update_job($pdo, $id, $data);
}

/**
 * Считывает фактические сегменты и длительность из HLS/логов.
 */
function refresh_progress(PDO $pdo, int $id, string $dir, float $duration, int $pid, int $lastProgressAt): array {
    if ($duration <= 0) {
        $duration = duration_from_media_cache($dir);
    }
    if ($duration <= 0) {
        $duration = duration_from_ffmpeg_log("$dir/ffmpeg.log");
        if ($duration > 0) {
            $info = duration_from_media_cache($dir, true);
            if (is_array($info)) {
                $info['duration'] = $duration;
                $info['duration_source'] = 'ffmpeg_log';
                write_json("$dir/media_info.json", $info);
            }
        }
    }

    $prep = playlist_seconds("$dir/index.m3u8");
    $segments = segment_count($dir);
    $progress = $duration > 0 ? min(99, round($prep / $duration * 100, 1)) : min(99, $segments);
    $now = now_ms();
    global $LOCK_HANDLE;
    lock_heartbeat($LOCK_HANDLE);
    $data = [
        'progress'=>$progress,
        'prepared_seconds'=>$prep,
        'segments'=>$segments,
        'pid'=>$pid,
        'worker_pid'=>getmypid(),
        'last_heartbeat_at'=>$now,
        'updated_at'=>$now,
    ];
    if ($duration > 0) $data['duration'] = $duration;
    update_job($pdo, $id, $data);
    return [$prep, $segments];
}

/**
 * Универсально обновляет поля задачи в SQLite.
 */
function update_job(PDO $pdo, int $id, array $data): void {
    if (!$data) return;
    $sets = [];
    $params = ['id'=>$id];
    foreach ($data as $k=>$v) {
        $sets[] = "$k=:$k";
        $params[$k] = $v;
    }
    $st = $pdo->prepare('UPDATE prepare_queue SET '.implode(',', $sets).' WHERE id=:id');
    $st->execute($params);
}

/**
 * Возвращает Basic Auth-заголовок TorrServer из bootstrap/config.
 */
function auth_header(): string { return lampa_sync_auth_header(); }
/**
 * Текущее время в миллисекундах.
 */
function now_ms(): int { return (int)round(microtime(true) * 1000); }
/**
 * Создаёт директорию при необходимости.
 */
function ensure_dir(string $d): void { if(!is_dir($d)) @mkdir($d,0777,true); }
/**
 * Собирает путь к директории по root и безопасному id.
 */
function session_dir(string $root,string $sid): string { return rtrim($root,'/').'/'.sid($sid); }
/**
 * Превращает строку в безопасный идентификатор директории.
 */
function sid(string $v): string { $v=trim($v); if($v==='') return ''; $s=preg_replace('~[^a-zA-Z0-9_-]+~','_',$v); $s=trim((string)$s,'_'); return substr($s ?: ('s_'.substr(sha1($v),0,16)),0,96); }
/**
 * Рекурсивно удаляет директорию задачи при retry/delete.
 */
function rrmdir(string $d): void { if(!is_dir($d)) return; foreach(scandir($d)?:[] as $i){ if($i==='.'||$i==='..') continue; $p="$d/$i"; is_dir($p)?rrmdir($p):@unlink($p);} @rmdir($d); }
/**
 * Читает JSON-файл в массив.
 */
function read_json(string $f): array { if(!is_file($f)) return []; $x=json_decode((string)file_get_contents($f),true); return is_array($x)?$x:[]; }
/**
 * Записывает массив в JSON-файл.
 */
function write_json(string $f,array $d): void { file_put_contents($f,json_encode($d,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_PRETTY_PRINT)); }
/**
 * Читает хвост лог-файла.
 */
function tail_file(string $f,int $n=4000): string { if(!is_file($f)) return ''; $s=filesize($f); if(!$s) return ''; $fp=fopen($f,'rb'); if(!$fp) return ''; if($s>$n) fseek($fp,-$n,SEEK_END); $r=(string)stream_get_contents($fp); fclose($fp); return $r; }
/**
 * Проверяет, жив ли процесс.
 */
function running(int $pid): bool { if($pid<=0) return false; if(function_exists('posix_kill')) return @posix_kill($pid,0); $c=1; @exec('kill -0 '.(int)$pid.' 2>/dev/null', $_, $c); return $c===0; }
/**
 * Завершает зависший ffmpeg/worker по PID.
 */
function kill_pid(int $pid): void { if($pid<=0) return; @exec('kill -TERM '.(int)$pid.' 2>/dev/null'); usleep(500000); if(running($pid)) @exec('kill -KILL '.(int)$pid.' 2>/dev/null'); }
/**
 * Считает созданные HLS-сегменты в prepared-директории.
 */
function segment_count(string $dir): int { return is_dir($dir) ? (count(glob("$dir/*.m4s") ?: []) + count(glob("$dir/*.ts") ?: [])) : 0; }
/**
 * Считает подготовленную длительность по HLS-плейлисту.
 */
function playlist_seconds(string $f): float { if(!is_file($f))return 0; preg_match_all('~#EXTINF:([0-9.]+)~',(string)file_get_contents($f),$m); $s=0; foreach($m[1]??[] as $v)$s+=(float)$v; return $s; }
/**
 * Проверяет, корректно ли ffmpeg завершил HLS-плейлист.
 */
function playlist_has_endlist(string $f): bool { return is_file($f) && stripos((string)file_get_contents($f), '#EXT-X-ENDLIST') !== false; }
/**
 * Получает duration из media_info.json или полный массив с info.
 */
function duration_from_media_cache(string $dir, bool $returnArray=false) {
    $f = rtrim($dir, '/') . '/media_info.json';
    if (!is_file($f) || filesize($f) <= 0) return $returnArray ? [] : 0.0;
    $j = json_decode((string)file_get_contents($f), true);
    if (!is_array($j)) return $returnArray ? [] : 0.0;
    if ($returnArray) return $j;
    $d = (float)($j['duration'] ?? 0);
    return $d > 0 ? $d : 0.0;
}
/**
 * Достаёт duration из строки Duration в ffmpeg.log.
 */
function duration_from_ffmpeg_log(string $f): float {
    if (!is_file($f) || filesize($f) <= 0) return 0.0;
    $log = tail_file($f, 12000);
    if (preg_match('~Duration:\\s*(\\d{1,2}):(\\d{2}):(\\d{2}(?:\\.\\d+)?)~', $log, $m)) {
        return ((int)$m[1]) * 3600 + ((int)$m[2]) * 60 + (float)$m[3];
    }
    return 0.0;
}
/**
 * Определяет критичные ошибки в ffmpeg.log.
 */
function ffmpeg_log_has_error(string $log): bool {
    $needles = [
        'Conversion failed',
        'Invalid data found',
        'Input/output error',
        'Connection timed out',
        'Operation timed out',
        'HTTP error',
        'Server returned',
        'Error while decoding stream',
        'Error writing trailer',
        'Immediate exit requested',
        'No route to host',
        'Connection refused',
        'End of file'
    ];
    foreach ($needles as $n) {
        if (stripos($log, $n) !== false) return true;
    }
    return false;
}

/**
 * Запускает ffprobe по TorrServer URL и кэширует параметры медиа.
 */
function media_info(string $url,string $dir): array {
    $cache="$dir/media_info.json";
    if(is_file($cache)&&filesize($cache)>0)return read_json($cache);

    $headers = lampa_sync_ffmpeg_headers();
    $cmd = 'timeout 45s '.escapeshellarg(FFPROBE_BIN).
        ' -v error'.
        ' -rw_timeout 600000000'.
        ' -analyzeduration 100M'.
        ' -probesize 100M'.
        ' -headers '.escapeshellarg($headers).
        ' -print_format json -show_format -show_streams '.escapeshellarg($url).' 2>&1';

    $raw = (string)@shell_exec($cmd);
    file_put_contents("$dir/ffprobe_raw.log", $raw);

    $pos = strpos($raw, '{');
    $json = $pos !== false ? substr($raw, $pos) : $raw;
    $j = json_decode($json, true);
    if (!is_array($j)) $j = [];

    $out = [
        'duration'=>0,
        'duration_source'=>'',
        'video_codec'=>'',
        'video_pix_fmt'=>'',
        'video_width'=>0,
        'video_height'=>0,
        'audio_codec'=>'',
        'audio_channels'=>0,
        'audio_tracks'=>[],
    ];

    if (isset($j['format']['duration']) && is_numeric($j['format']['duration']) && (float)$j['format']['duration'] > 0) {
        $out['duration'] = (float)$j['format']['duration'];
        $out['duration_source'] = 'ffprobe_format';
    }

    $audioIndex = 0;
    foreach (($j['streams'] ?? []) as $st) {
        if (($st['codec_type'] ?? '') === 'video' && $out['video_codec'] === '') {
            $out['video_codec'] = strtolower((string)($st['codec_name'] ?? ''));
            $out['video_pix_fmt'] = strtolower((string)($st['pix_fmt'] ?? ''));
            $out['video_width'] = (int)($st['width'] ?? 0);
            $out['video_height'] = (int)($st['height'] ?? 0);
            if ($out['duration'] <= 0 && isset($st['duration']) && is_numeric($st['duration']) && (float)$st['duration'] > 0) {
                $out['duration'] = (float)$st['duration'];
                $out['duration_source'] = 'ffprobe_video_stream';
            }
        }
        if (($st['codec_type'] ?? '') === 'audio') {
            $tags = is_array($st['tags'] ?? null) ? $st['tags'] : [];
            $disp = is_array($st['disposition'] ?? null) ? $st['disposition'] : [];
            $track = [
                'audio_index'=>$audioIndex,
                'stream_index'=>(int)($st['index'] ?? $audioIndex),
                'codec'=>strtolower((string)($st['codec_name'] ?? '')),
                'channels'=>(int)($st['channels'] ?? 0),
                'language'=>strtolower((string)($tags['language'] ?? '')),
                'title'=>(string)($tags['title'] ?? ''),
                'default'=>!empty($disp['default']),
            ];
            $track['label'] = audio_track_label($track);
            $out['audio_tracks'][] = $track;

            if ($out['audio_codec'] === '') {
                $out['audio_codec'] = $track['codec'];
                $out['audio_channels'] = $track['channels'];
                if ($out['duration'] <= 0 && isset($st['duration']) && is_numeric($st['duration']) && (float)$st['duration'] > 0) {
                    $out['duration'] = (float)$st['duration'];
                    $out['duration_source'] = 'ffprobe_audio_stream';
                }
            }
            $audioIndex++;
        }
    }

    write_json($cache, $out);
    return $out;
}

/**
 * Читабельное имя аудиодорожки для страницы очереди и плеера.
 */
function audio_track_label(array $track): string {
    $parts=[];
    $parts[]='Аудио '.((int)($track['audio_index']??0)+1);
    if(!empty($track['language']))$parts[]=strtoupper((string)$track['language']);
    if(!empty($track['title']))$parts[]=(string)$track['title'];
    if(!empty($track['codec']))$parts[]=strtoupper((string)$track['codec']);
    if(!empty($track['channels']))$parts[]=(string)$track['channels'].'ch';
    if(!empty($track['default']))$parts[]='default';
    return implode(' · ', $parts);
}

/**
 * Проверяет, что выбранная дорожка есть в исходнике.
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

function audio_browser_args(string $bitrate='128k', bool $resetPts=true): array {
    $filter = $resetPts ? 'aresample=async=1000:first_pts=0' : 'aresample=async=1000';
    return ['-c:a aac','-profile:a aac_low','-b:a '.escapeshellarg($bitrate),'-ac 2','-ar 48000','-af '.escapeshellarg($filter)];
}
/**
 * Параметры видео для стабильного sync-safe H.264.
 */
function video_syncsafe_args(int $width,string $preset,string $crf,string $threads): array {
    return ['-c:v libx264','-preset '.escapeshellarg($preset),'-crf '.escapeshellarg($crf),'-threads '.escapeshellarg($threads),'-pix_fmt yuv420p','-vf '.escapeshellarg("setpts=PTS-STARTPTS,scale='min($width,iw)':-2"),'-tune fastdecode','-x264-params '.escapeshellarg('keyint=48:min-keyint=48:scenecut=0')];
}
/**
 * Выбор профиля кодирования для фоновой подготовки.
 */
function encoding(array $m,string $quality): array {
    $vc=$m['video_codec']??''; $pix=$m['video_pix_fmt']??'';
    $safeH264 = $vc === 'h264' && $pix !== '' && !str_contains($pix, '10') && !str_contains($pix, '12');
    if($quality === 'copy' && $safeH264){
        return ['name'=>'copy_video_fmp4_safe_audio_debug','video_args'=>['-c:v copy'],'audio_args'=>audio_browser_args('128k', false),'segment_type'=>'fmp4','preserve_timestamps'=>false,'cpu_level'=>'very_low_desync_risk'];
    }
    if($quality==='lowcpu'){ $w=854; $preset='ultrafast'; $crf='31'; $thr='1'; $ab='112k'; $cpu='low_controlled'; }
    elseif($quality==='balanced'){ $w=1280; $preset='veryfast'; $crf='25'; $thr='2'; $ab='160k'; $cpu='medium'; }
    elseif($quality==='safe'){ $w=1280; $preset='veryfast'; $crf='24'; $thr='2'; $ab='160k'; $cpu='safe_medium'; }
    elseif($quality==='ultra'){ $w=1920; $preset='veryfast'; $crf='18'; $thr='2'; $ab='192k'; $cpu='ultra_high_quality_heavy'; }
    else { $w=960; $preset='ultrafast'; $crf='29'; $thr='1'; $ab='128k'; $cpu='syncsafe_low_medium'; }
    $profileName = $quality === 'ultra' ? 'ultra_quality_fmp4' : ($quality === 'safe' ? 'safe_full_transcode_fmp4' : 'syncsafe_fmp4');
    return ['name'=>$profileName,'description'=>'prepared sync-safe H.264/AAC-LC fMP4','video_args'=>video_syncsafe_args($w,$preset,$crf,$thr),'audio_args'=>audio_browser_args($ab,true),'segment_type'=>'fmp4','preserve_timestamps'=>false,'cpu_level'=>$cpu,'source_video_was_browser_safe_h264'=>$safeH264];
}
