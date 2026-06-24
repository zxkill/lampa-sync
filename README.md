# Lampa Sync Player

Lampa Sync Player — экспериментальный плагин и серверный слой для [Lampa](https://github.com/yumata/lampa), который добавляет собственный HTML5/HLS-плеер, синхронизацию прогресса между устройствами и фоновую подготовку видео из TorrServer в готовый HLS-кэш.

Проект появился как решение практической задачи: смотреть TorrServer-потоки в браузерах и на iOS/Android/TV стабильнее, сохранять прогресс и заранее подготавливать тяжёлые видео, чтобы потом воспроизводить их с сервера без повторной конвертации.

> Проект не содержит контента, не распространяет видео и не обходит ограничения источников. Он работает только с теми ссылками/потоками, которые пользователь уже может открыть в своей Lampa/TorrServer-инсталляции.

## Возможности

- Перехват `Lampa.Player.play()` и запуск собственного плеера в iframe-оверлее.
- Поддержка HLS через `hls.js` в Chrome/Android/TV и нативного HLS там, где он доступен.
- Серверная конвертация TorrServer-потока через `ffmpeg` в HLS/fMP4.
- Режимы качества подготовки: `lowcpu`, `fast`, `balanced`, `safe`.
- Фоновая очередь подготовки:
  - добавление из плеера;
  - добавление прямой ссылкой на странице очереди;
  - добавление из стандартного меню Lampa «Действие → Скачать в Lampa Sync»;
  - watchdog/retry/heartbeat для worker-а;
  - страница очереди с прогрессом.
- Быстрое открытие уже подготовленных файлов: перехват `Lampa.Torserver.stream()` и подмена готового TorrServer-потока на prepared-HLS с сервера.
- Синхронизация прогресса Lampa localStorage через `progress.php`.
- Кнопки управления в собственном плеере, поддержка клавиш/пульта, закрытие оверлея.

## Что пока не идеально

- Проект экспериментальный и зависит от внутренних API Lampa. После обновлений Lampa некоторые хуки могут потребовать адаптации.
- Фоновая подготовка через TorrServer зависит от сидов и скорости отдачи торрента. Если TorrServer долго не отдаёт данные, `ffmpeg` будет ждать.
- Полноценного менеджера настроек пока нет: основная настройка выполняется в `config.php` и константах JS-плагина.
- Не реализовано аккуратное продолжение частично подготовленного HLS после падения: при retry задача обычно пересобирается заново.
- Не все онлайн-плагины Lampa могут отдавать URL в одинаковом формате. Для TorrServer основной сценарий покрыт лучше.

## Требования

- PHP 8.1+ с расширениями:
  - `curl`
  - `pdo_sqlite`
  - `sqlite3`
- CLI PHP (`/usr/bin/php` или другой путь для cron/worker).
- `ffmpeg` и `ffprobe`.
- TorrServer, доступный с сервера по HTTP.
- Веб-сервер с HTTPS, если Lampa открывается по HTTPS.

## Установка

Скопируйте файлы проекта в каталог, доступный по HTTP, например:

```bash
/var/www/example.com/html/lampa-sync/
```

Создайте конфиг:

```bash
cd /var/www/example.com/html/lampa-sync
cp config.example.php config.php
nano config.php
```

Минимально нужно указать:

```php
const BASE_PUBLIC_URL = 'https://your-domain.example/lampa-sync';
const API_PUBLIC_URL = BASE_PUBLIC_URL . '/api.php';
const QUEUE_PUBLIC_URL = BASE_PUBLIC_URL . '/prepare_queue.html';

const TORRSERVER_LOCAL_BASE = 'http://127.0.0.1:8090';
const TORRSERVER_LOGIN = '';
const TORRSERVER_PASSWORD = '';

const FFMPEG_BIN = 'ffmpeg';
const FFPROBE_BIN = 'ffprobe';
```

Создайте директорию данных и права на запись для пользователя веб-сервера и CLI worker-а:

```bash
mkdir -p data
chown -R www-data:www-data data
chmod -R 775 data
```

Для CentOS/Apache пользователь может быть `apache`:

```bash
chown -R apache:apache data
```

## Проверка API

```text
https://your-domain.example/lampa-sync/api.php?debug=1
https://your-domain.example/lampa-sync/progress.php?user_id=1&profile=0&debug=1
https://your-domain.example/lampa-sync/prepare_queue.html
```

В `debug=1` должны быть видны `ffmpeg_exists`, `ffprobe_exists`, `pdo_sqlite`, `curl`.

## Подключение плагина в Lampa

Подключите файл:

```text
https://your-domain.example/lampa-sync/lampa-sync-plugin.js
```

Плагин старается сам определить базовый URL по адресу собственного JS-файла. Если ваша схема загрузки плагина нестандартная, можно заранее задать:

```js
window.LAMPA_SYNC_CONFIG = {
  baseUrl: 'https://your-domain.example/lampa-sync',
  quality: 'fast'
};
```

## Фоновая очередь подготовки

Страница очереди:

```text
https://your-domain.example/lampa-sync/prepare_queue.html
```

Добавить задачу можно тремя способами:

1. Открыть плеер и нажать «Скачать».
2. Вставить прямую ссылку TorrServer/Lampa на странице очереди.
3. В Lampa открыть меню «Действие» у файла/серии и нажать «Скачать в Lampa Sync».

Готовые HLS-файлы сохраняются в:

```bash
data/prepared/
```

Временные HLS-сессии онлайн-просмотра находятся в:

```bash
data/hls/
```

## Worker и watchdog

Worker можно запускать вручную:

```bash
php /var/www/example.com/html/lampa-sync/prepare_worker.php
```

Рекомендуется добавить cron, чтобы зависшие/упавшие задачи автоматически поднимались:

```bash
* * * * * /usr/bin/php /var/www/example.com/html/lampa-sync/prepare_worker.php --watchdog >> /var/www/example.com/html/lampa-sync/data/prepare_cron.log 2>&1
```

Worker обрабатывает задачи по одной. Lock-файл защищает сервер от параллельного запуска нескольких тяжёлых `ffmpeg`-процессов.

## Основные endpoints

```text
api.php?debug=1
api.php?prepare_start=1
api.php?prepare_status=1&content_id=...
api.php?prepare_list=1
api.php?prepare_delete=1&content_id=...
api.php?prepare_retry=1&content_id=...
api.php?prepare_kick=1
api.php?prepare_reset_stalled=1
api.php?prepared_hls=1&key=...&file=index.m3u8
```

## Безопасность перед публикацией

В публичный репозиторий нельзя коммитить:

- `config.php`
- папку `data/`
- SQLite-базы
- HLS-сегменты
- логи
- реальные логины/пароли TorrServer
- реальные домены/IP, если вы не хотите их раскрывать

`.gitignore` уже настроен под это.

## Дорожная карта

- Более аккуратная работа с онлайн-плагинами Lampa, которые не используют TorrServer.
- Настраиваемые профили качества из UI.
- Более точный расчёт ETA/скорости подготовки.
- Ограничение CPU/потоков через настройки.
- Авторизация страницы очереди.
- Docker Compose для развёртывания.
- Более чистая архитектура API и разделение файлов.

## Участие в разработке

Идеи, issue и pull request приветствуются. Проект пока экспериментальный, поэтому особенно полезны отчёты по разным устройствам: iOS Safari, Android TV, Chrome/Windows, WebView-приложения и разные версии TorrServer/Lampa.

## Лицензия

MIT. См. `LICENSE`.
