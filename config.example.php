<?php
/**
 * Пример конфигурации Lampa Sync.
 *
 * Перед установкой скопируйте этот файл в config.php и заполните значения под свой сервер:
 *   cp config.example.php config.php
 *   nano config.php
 *
 * Настоящий config.php нельзя коммитить в Git: в нём могут быть домены, локальные пути и пароль TorrServer.
 */
declare(strict_types=1);

if (!defined('LAMPA_SYNC_BOOTSTRAP')) {
    http_response_code(403);
    exit('Forbidden');
}

// Публичный URL каталога, куда загружены файлы проекта. Без слэша в конце.
// Пример: https://your-domain.example/lampa-sync
const BASE_PUBLIC_URL = 'https://example.com/lampa-sync';

// URL API и страницы очереди обычно строятся автоматически от BASE_PUBLIC_URL.
const API_PUBLIC_URL = BASE_PUBLIC_URL . '/api.php';
const QUEUE_PUBLIC_URL = BASE_PUBLIC_URL . '/prepare_queue.html';

// Локальный адрес TorrServer, доступный именно с PHP-сервера.
// Обычно это TorrServer на той же машине, поэтому 127.0.0.1:8090.
const TORRSERVER_LOCAL_BASE = 'http://127.0.0.1:8090';

// Basic Auth для TorrServer. Если авторизация отключена, оставьте обе строки пустыми.
const TORRSERVER_LOGIN = '';
const TORRSERVER_PASSWORD = '';

// Пути к ffmpeg и ffprobe. Можно указать просто имена, если они доступны в PATH.
// Если worker не находит бинарники, укажите абсолютные пути: /usr/bin/ffmpeg и /usr/bin/ffprobe.
const FFMPEG_BIN =  __DIR__ . '/bin/ffmpeg';
const FFPROBE_BIN = __DIR__ . '/bin/ffprobe';

// Рабочая директория проекта: SQLite-базы, временные HLS-сессии, подготовленные файлы и логи.
// Должна быть доступна на запись и веб-серверу, и CLI-worker-у.
const LAMPA_SYNC_DATA_DIR = __DIR__ . '/data';

// Ограничения для временных HLS-сессий онлайн-просмотра.
const HLS_TTL = 1800;              // сколько секунд хранить неактивную временную сессию
const HLS_DONE_TTL = 7200;         // сколько секунд хранить завершённую временную сессию
const HLS_MAX_BYTES = 8000000000;  // общий лимит временного HLS-кэша
const HLS_SEGMENT_SECONDS = 4;     // длительность одного HLS-сегмента в секундах

// Пороговые значения watchdog-а. Он помогает перезапускать зависшие задачи подготовки.
const WORKER_HEARTBEAT_STALE_MS = 10 * 60 * 1000;     // worker считается зависшим без heartbeat 10 минут
const FFMPEG_NO_PROGRESS_STALE_MS = 15 * 60 * 1000;   // ffmpeg считается зависшим без прогресса 15 минут
