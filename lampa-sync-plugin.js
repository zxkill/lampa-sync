(function () {
  'use strict';

  // Определяет базовый URL плагина по адресу текущего script-тега.
  function detectPluginBaseUrl() {
    try {
      const cfg = window.LAMPA_SYNC_CONFIG || {};
      if (cfg.baseUrl) return String(cfg.baseUrl).replace(/\/+$/, '');
      if (window.LAMPA_SYNC_BASE_URL) return String(window.LAMPA_SYNC_BASE_URL).replace(/\/+$/, '');
      const s = document.currentScript && document.currentScript.src ? document.currentScript.src : '';
      if (s) return new URL('.', s).toString().replace(/\/+$/, '');
    } catch (e) {}
    return '';
  }

  // Склеивает базовый URL и имя файла без двойных слэшей.
  function joinBase(base, file) {
    if (!base) return file;
    return base.replace(/\/+$/, '') + '/' + file.replace(/^\/+/, '');
  }

  const PLUGIN_BASE_URL = detectPluginBaseUrl();

  // URL строятся относительно самого JS-файла, чтобы плагин не был привязан к конкретному домену.
  const PLAYER_URL = (window.LAMPA_SYNC_CONFIG && window.LAMPA_SYNC_CONFIG.playerUrl) || joinBase(PLUGIN_BASE_URL, 'player.html');
  const PREPARE_API_URL = (window.LAMPA_SYNC_CONFIG && window.LAMPA_SYNC_CONFIG.apiUrl) || joinBase(PLUGIN_BASE_URL, 'api.php');
  const QUALITY = (window.LAMPA_SYNC_CONFIG && window.LAMPA_SYNC_CONFIG.quality) || 'fast'; // lowcpu | fast | balanced | safe

  const STORAGE_SYNC_API_URL = (window.LAMPA_SYNC_CONFIG && window.LAMPA_SYNC_CONFIG.progressApiUrl) || joinBase(PLUGIN_BASE_URL, 'progress.php');

  const STORAGE_SYNC_PLUGIN_ID = 'lampa_sync_storage';
  const STORAGE_SYNC_META_KEY = 'lampa_sync_storage_meta_v2';
  const STORAGE_SYNC_DEVICE_KEY = 'lampa_sync_storage_device_id';


  // Настройки синхронизации состояния Lampa через progress.php.
  /*
   * Activity is allowed to navigate the UI only as a remote command:
   * - origin_device must be another device;
   * - server updated_at must be newer than local meta;
   * - each remote activity token is applied once;
   * - local rewrites caused by Activity.replace are suppressed for a few seconds.
   */
  const ACTIVITY_RUNTIME_APPLY = true;
  const ACTIVITY_LOCAL_GUARD_MS = 5000;
  const ACTIVITY_APPLY_COOLDOWN_MS = 2500;
  const ACTIVITY_ECHO_SUPPRESS_MS = 6000;
  const ACTIVITY_STARTUP_GUARD_MS = 8000;
  const ACTIVITY_STARTUP_REPULL_1_MS = 1200;
  const ACTIVITY_STARTUP_REPULL_2_MS = 3500;

  /*
   * Cross-device sync should not depend on unstable Lampa profile detection.
   * We still update profile-specific localStorage keys, but store the server bundle
   * under a stable per-account profile scope. For multi-profile usage this can be
   * changed to '' and then ids.profileId will be used below.
   */
  const STORAGE_SYNC_SERVER_PROFILE_ID = '0'; // user-level scope; set '' for separate Lampa profiles

  const LOCAL_POLL_MS = 900;
  const SERVER_META_POLL_MS = 2500;
  const PUSH_DEBOUNCE_MS = 1200;
  const WAIT_IDS_MS = 15000;
  const WAIT_STEP_MS = 500;

  /*
   * Only keys needed for the current task:
   * - file_view / file_view_<profile>  -> watch progress
   * - online_watched_last/list         -> watch history
   * - activity                         -> active page / app state
   *
   * Do not sync plugins/settings/menu/favorites here.
   */
  const BASE_SYNC_KEYS = [
    'activity',
    'favorite',
    'plugins',
    'recomends_list',
    'recomends_scan',
    'torrents_view',
    'torrents_filter_data',
    'torrents_filter',
    'file_view',
    'online_watched_last',
    'online_watched_list'
  ];

  let originalPlay = null;
  let overlay = null;
  let iframe = null;

  let lastOpenUrl = '';
  let lastOpenAt = 0;
  let opening = false;

  let currentPlayback = null;

  let storageCtx = null;
  let storageKeys = null;
  let lastRawSnapshot = null;
  let lastServerMeta = {};
  let lastSeenServerMeta = {};
  let serverMetaInFlight = false;
  let pendingKeys = {};
  let pushTimer = null;
  let storageSyncStarted = false;
  let forceFetchTick = 0;
  let lastAppliedActivityRaw = '';
  let lastAppliedActivityFingerprint = '';
  let lastActivityRuntimeAppliedAt = 0;
  let pendingRemoteActivityRaw = '';
  let pendingRemoteActivityPacket = null;
  let lastRemoteActivityAppliedToken = '';
  let suppressActivityPushUntil = 0;
  let localChangeAt = {};
  let lastUiRefreshAt = 0;
  let lastUiRefreshSignature = '';
  let initialPullDone = false;
  let activityStartupGuardUntil = 0;
  let activitySnapshotInFlight = false;


  // Кэш готовых prepared-HLS задач: нужен для быстрого открытия без TorrServer preload.
  let preparedFastIndex = [];
  let preparedFastByTorrent = {};
  let preparedFastByHls = {};
  let preparedFastByHashPath = {};
  let preparedFastIndexAt = 0;
  let preparedFastIndexLoading = false;
  let originalTorserverStream = null;
  let torserverStreamHookInstalled = false;
  let originalSelectShow = null;
  let selectPrepareHookInstalled = false;
  let selectCopyCapture = null;

  // Главная инициализация плагина после появления объекта Lampa.
  function start() {
    if (!window.Lampa || !Lampa.Player || !Lampa.Player.play) {
      setTimeout(start, 1000);
      return;
    }

    if (originalPlay) {
      return;
    }

    installSettings();
    installPreparedFastOpen();

    originalPlay = Lampa.Player.play;

    Lampa.Player.play = function (data) {
      console.log('[Lampa Sync] intercepted:', data);

      let streamUrl = getStreamUrl(data);

      if (!streamUrl) {
        console.warn('[Lampa Sync] stream url not found, fallback to original player');
        return originalPlay.apply(this, arguments);
      }

      /*
       * The playback URL/content_id can change when prepared-HLS is matched,
       * but resume progress must stay tied to the original Lampa item id.
       * Older working versions used one stable cid for read/save/start; losing
       * that identity is what makes the SQLite progress row look "missing".
       */
      const originalStreamUrl = streamUrl;
      const progressContentId = getContentId(data, originalStreamUrl);

      const preparedItemFromPlayer = findPreparedFastItem(streamUrl);
      if (preparedItemFromPlayer && (preparedItemFromPlayer.source_url || preparedItemFromPlayer.normalized_url)) {
        console.log('[Lampa Sync] prepared cache matched in Player.play:', preparedItemFromPlayer);
        streamUrl = preparedItemFromPlayer.source_url || preparedItemFromPlayer.normalized_url || streamUrl;
      }

      const title = preparedItemFromPlayer && preparedItemFromPlayer.title ? preparedItemFromPlayer.title : getTitle(data);
      const contentId = preparedItemFromPlayer && preparedItemFromPlayer.content_id ? preparedItemFromPlayer.content_id : progressContentId;

      currentPlayback = {
        data: data || {},
        streamUrl: streamUrl,
        title: title,
        contentId: progressContentId,
        mediaContentId: contentId,
        openedAt: Date.now(),
        preparedItem: preparedItemFromPlayer || null
      };

      const progressAltIds = buildProgressAltIds(progressContentId, originalStreamUrl, streamUrl, preparedItemFromPlayer);

      const playerUrl =
        PLAYER_URL +
        '?url=' + encodeURIComponent(streamUrl) +
        '&title=' + encodeURIComponent(title) +
        '&content_id=' + encodeURIComponent(contentId) +
        '&progress_content_id=' + encodeURIComponent(progressContentId) +
        '&progress_alt_ids=' + encodeURIComponent(progressAltIds.join(',')) +
        '&transcode=1' +
        '&quality=' + encodeURIComponent(QUALITY) +
        '&v=' + Date.now();

      openOverlay(playerUrl, title);

      return false;
    };

    bindEvents();
    startStorageSyncWhenReady();

    console.log('[Lampa Sync] enabled: iframe overlay + HLS/FFmpeg + clean localStorage sync v8.11-progress-stream-id-fix');
  }

  // Открывает наш player.html поверх интерфейса Lampa в iframe.
  function openOverlay(url, title) {
    const now = Date.now();

    if (opening && lastOpenUrl === url && now - lastOpenAt < 1500) {
      console.log('[Lampa Sync] duplicate open ignored');
      return;
    }

    opening = true;
    lastOpenUrl = url;
    lastOpenAt = now;

    closeOverlay(false, true);

    overlay = document.createElement('div');
    overlay.id = 'lampa-sync-overlay';

    overlay.style.position = 'fixed';
    overlay.style.left = '0';
    overlay.style.top = '0';
    overlay.style.right = '0';
    overlay.style.bottom = '0';
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.background = '#000';
    overlay.style.zIndex = '2147483647';
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    overlay.style.opacity = '1';
    overlay.style.pointerEvents = 'auto';

    iframe = document.createElement('iframe');
    iframe.id = 'lampa-sync-player-frame';
    iframe.tabIndex = 0;
    iframe.src = url;
    iframe.allow = 'autoplay; fullscreen; picture-in-picture';
    iframe.allowFullscreen = true;
    iframe.setAttribute('webkitallowfullscreen', 'true');
    iframe.setAttribute('mozallowfullscreen', 'true');

    iframe.style.border = '0';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.flex = '1 1 auto';
    iframe.style.background = '#000';
    iframe.style.display = 'block';

    iframe.addEventListener('load', function () {
      opening = false;

      try {
        iframe.focus();
      } catch (e) {}

      setTimeout(function () {
        try {
          iframe && iframe.focus();
        } catch (e) {}
      }, 120);

      console.log('[Lampa Sync] iframe loaded');
    });

    overlay.appendChild(iframe);
    document.body.appendChild(overlay);

    try {
      document.body.classList.add('lampa-sync-opened');
    } catch (e) {}

    setTimeout(function () {
      opening = false;
    }, 2500);
  }

  // Закрывает iframe-плеер и возвращает управление Lampa.
  function closeOverlay(notifyPlayer = true, immediate = false) {
    if (!overlay && !iframe) {
      return;
    }

    const oldOverlay = overlay;
    const oldIframe = iframe;

    overlay = null;
    iframe = null;
    opening = false;

    if (notifyPlayer && oldIframe && oldIframe.contentWindow) {
      try {
        oldIframe.contentWindow.postMessage({ type: 'lampa-sync-close' }, '*');
      } catch (e) {}
    }

    const remove = function () {
      if (oldIframe) {
        try {
          oldIframe.src = 'about:blank';
        } catch (e) {}
      }

      if (oldOverlay && oldOverlay.parentNode) {
        oldOverlay.parentNode.removeChild(oldOverlay);
      }

      try {
        document.body.classList.remove('lampa-sync-opened');
      } catch (e) {}

      setTimeout(function () {
        try { applyPendingRemoteActivity(); } catch (e) {}
      }, 80);
    };

    if (immediate) {
      remove();
    } else {
      setTimeout(remove, notifyPlayer ? 250 : 0);
    }
  }

  // Подписывает клавиатуру, Back/Escape и сообщения от iframe-плеера.
  function bindEvents() {
    document.addEventListener('keydown', function (event) {
      if (!overlay) return;

      const key = event.key || event.code || '';
      const keyCode = event.keyCode || event.which || 0;

      const isBack =
        key === 'Escape' ||
        key === 'Backspace' ||
        key === 'BrowserBack' ||
        keyCode === 27 ||
        keyCode === 8 ||
        keyCode === 461 ||
        keyCode === 10009;

      event.preventDefault();
      event.stopPropagation();

      if (typeof event.stopImmediatePropagation === 'function') {
        event.stopImmediatePropagation();
      }

      if (isBack) {
        closeOverlay(true, false);
        return;
      }

      forwardRemoteKey(event);

      setTimeout(function () {
        try {
          iframe && iframe.focus();
        } catch (e) {}
      }, 0);
    }, true);

    window.addEventListener('message', function (event) {
      const data = event.data || {};

      if (data.type === 'lampa-sync-request-close') {
        closeOverlay(false, true);
        return;
      }

      if (data.type === 'lampa-sync-progress' && data.payload) {
        updateLampaProgress(data.payload);
        return;
      }
    });

    window.addEventListener('popstate', function () {
      if (overlay) {
        closeOverlay(true, false);
      }
    });
  }

  // Пробрасывает нажатия пульта/клавиатуры из Lampa в iframe-плеер.
  function forwardRemoteKey(event) {
    if (!iframe || !iframe.contentWindow) {
      return;
    }

    try {
      iframe.contentWindow.postMessage({
        type: 'lampa-sync-remote-key',
        key: event.key || '',
        code: event.code || '',
        keyCode: event.keyCode || event.which || 0,
        which: event.which || event.keyCode || 0,
        altKey: !!event.altKey,
        ctrlKey: !!event.ctrlKey,
        shiftKey: !!event.shiftKey,
        metaKey: !!event.metaKey
      }, '*');
    } catch (e) {}
  }


  // ---------------------------------------------------------------------------
  // Prepared fast open.
  // ---------------------------------------------------------------------------

  // Включает быстрый запуск готового HLS и периодическое обновление индекса очереди.
  function installPreparedFastOpen() {
    installTorserverStreamHook();
    installSelectPrepareHook();
    refreshPreparedFastIndex(false);
    setInterval(function () {
      refreshPreparedFastIndex(false);
    }, 15000);

    document.addEventListener('click', handlePreparedFastClick, true);
    document.addEventListener('touchend', handlePreparedFastClick, true);
  }

  // Загружает список готовых задач из prepare_list.
  async function refreshPreparedFastIndex(force) {
    const now = Date.now();
    if (!force && preparedFastIndexAt && now - preparedFastIndexAt < 12000) return preparedFastIndex;
    if (preparedFastIndexLoading) return preparedFastIndex;

    preparedFastIndexLoading = true;

    try {
      const r = await fetch(PREPARE_API_URL + '?prepare_list=1&limit=300&t=' + now, { cache: 'no-store' });
      const d = await r.json();
      const items = d && d.ok && Array.isArray(d.items) ? d.items : [];
      preparedFastIndex = items
        .filter(function (item) {
          return item && item.status === 'ready' && item.hls_url;
        })
        .map(function (item) {
          const torrentKey = String(item.torrent_key || makeTorrentKey(item.torrent_hash, item.file_index) || '');
          return {
            content_id: String(item.content_id || ''),
            title: String(item.title || 'Видео'),
            hls_url: String(item.hls_url || ''),
            source_url: String(item.source_url || ''),
            normalized_url: String(item.normalized_url || ''),
            torrent_hash: String(item.torrent_hash || '').toLowerCase(),
            file_index: Number(item.file_index ?? -1),
            stream_path: String(item.stream_path || ''),
            torrent_key: torrentKey,
            source_key: preparedUrlKey(item.source_url || ''),
            normalized_key: preparedUrlKey(item.normalized_url || ''),
            hls_key: preparedUrlKey(item.hls_url || '')
          };
        });
      rebuildPreparedFastMaps();
      preparedFastIndexAt = now;
    } catch (e) {}

    preparedFastIndexLoading = false;
    return preparedFastIndex;
  }


  // Строит быстрые lookup-карты по torrent_key, HLS URL и hash+path.

  function rebuildPreparedFastMaps() {
    preparedFastByTorrent = {};
    preparedFastByHls = {};
    preparedFastByHashPath = {};

    preparedFastIndex.forEach(function (item) {
      if (item.torrent_key) preparedFastByTorrent[item.torrent_key] = item;
      if (item.hls_key) preparedFastByHls[item.hls_key] = item;

      const hp = makeHashPathKey(item.torrent_hash, item.stream_path || item.source_url || item.normalized_url || '');
      if (hp) preparedFastByHashPath[hp] = item;
    });
  }


  // Встраивает пункт “Скачать в Lampa Sync” в стандартное меню действия Lampa.

  function installSelectPrepareHook() {
    if (selectPrepareHookInstalled) return true;

    if (!window.Lampa || !Lampa.Select || typeof Lampa.Select.show !== 'function') {
      setTimeout(installSelectPrepareHook, 1000);
      return false;
    }

    originalSelectShow = Lampa.Select.show;
    selectPrepareHookInstalled = true;

    Lampa.Select.show = function (params) {
      try {
        if (selectCopyCapture && params && Array.isArray(params.items)) {
          const files = [];
          params.items.forEach(function (item) {
            const file = item && (item.file || item.url || item.link);
            if (file && isProbablyVideoUrl(file)) files.push(String(file));
          });

          if (files.length) {
            selectCopyCapture.files = selectCopyCapture.files.concat(files);
            selectCopyCapture.handled = true;
            return;
          }
        }

        decorateActionMenuWithPrepare(params);
      } catch (e) {
        console.warn('[Lampa Sync] Select.show prepare hook failed:', e);
      }

      return originalSelectShow.apply(this, arguments);
    };

    console.log('[Lampa Sync] Select action menu hook installed');
    return true;
  }

  // Добавляет пункт подготовки рядом с “Копировать ссылку на видео”.
  function decorateActionMenuWithPrepare(params) {
    if (!params || !Array.isArray(params.items) || params.lampa_sync_prepare_decorated) return;

    const copyIndex = findCopyLinkItemIndex(params.items);
    if (copyIndex < 0) return;

    const title = String(params.title || '').toLowerCase();
    const hasPlayerItem = params.items.some(function (item) {
      const text = String((item && item.title) || '').toLowerCase();
      return !!(item && item.player) || text.indexOf('плеер') >= 0 || text.indexOf('player') >= 0;
    });

    const looksLikeActionMenu =
      title.indexOf('действ') >= 0 ||
      title.indexOf('action') >= 0 ||
      hasPlayerItem;

    if (!looksLikeActionMenu) return;

    const originalOnSelect = typeof params.onSelect === 'function' ? params.onSelect : null;
    const copyItem = params.items[copyIndex];

    params.items.splice(copyIndex + 1, 0, {
      title: 'Скачать в Lampa Sync',
      subtitle: 'Добавить этот файл в очередь подготовки',
      lampa_sync_prepare: true,
      onSelect: function () {
        prepareFromActionMenu(params, copyItem, originalOnSelect);
      }
    });

    params.lampa_sync_prepare_decorated = true;
  }

  // Находит пункт меню, который умеет копировать stream URL.
  function findCopyLinkItemIndex(items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i] || {};
      const title = String(item.title || '').toLowerCase();
      if (item.copylink) return i;
      if (title.indexOf('копировать') >= 0 && title.indexOf('ссыл') >= 0) return i;
      if (title.indexOf('copy') >= 0 && title.indexOf('link') >= 0) return i;
    }

    return -1;
  }
  async function prepareFromActionMenu(params, copyItem, originalOnSelect) {
    try {
      let urls = captureUrlsFromCopyLink(copyItem, originalOnSelect);
      urls = unique((urls || []).map(String).filter(isProbablyVideoUrl));

      if (!urls.length) {
        showPrepareMessage('Не удалось получить ссылку из меню');
        console.warn('[Lampa Sync] prepare menu: no URL captured', { params: params, copyItem: copyItem });
        return;
      }

      const url = urls[0];
      const title = guessPrepareTitleFromMenu(params, url);

      showPrepareMessage('Добавляю в очередь...');

      const api =
        PREPARE_API_URL +
        '?prepare_start=1' +
        '&quality=' + encodeURIComponent(QUALITY) +
        '&title=' + encodeURIComponent(title) +
        '&url=' + encodeURIComponent(url) +
        '&t=' + Date.now();

      const r = await fetch(api, { cache: 'no-store' });
      const d = await r.json();

      if (!d || !d.ok) {
        throw new Error((d && d.error) || 'prepare_start failed');
      }

      await refreshPreparedFastIndex(true);

      showPrepareMessage(d.already ? 'Уже есть в очереди' : 'Добавлено в очередь');
      console.log('[Lampa Sync] prepared queue add from action menu:', { title: title, url: url, response: d });
    } catch (e) {
      console.warn('[Lampa Sync] prepare menu failed:', e);
      showPrepareMessage('Не удалось добавить в очередь');
    }
  }

  // Временно перехватывает внутреннее копирование ссылки и забирает реальный stream URL.
  function captureUrlsFromCopyLink(copyItem, originalOnSelect) {
    const captured = [];

    if (copyItem) {
      ['file', 'url', 'link', 'stream', 'video', 'src'].forEach(function (key) {
        if (copyItem[key]) captured.push(String(copyItem[key]));
      });
    }

    if (!originalOnSelect || !window.Lampa || !Lampa.Utils || typeof Lampa.Utils.copyTextToClipboard !== 'function') {
      return captured;
    }

    const originalCopy = Lampa.Utils.copyTextToClipboard;
    const prevCapture = selectCopyCapture;

    selectCopyCapture = {
      files: [],
      handled: false
    };

    Lampa.Utils.copyTextToClipboard = function (text) {
      if (text) captured.push(String(text));
      return true;
    };

    try {
      originalOnSelect(copyItem || { copylink: true }, null);
    } catch (e) {
      console.warn('[Lampa Sync] copylink capture failed:', e);
    }

    if (selectCopyCapture && selectCopyCapture.files && selectCopyCapture.files.length) {
      captured.push.apply(captured, selectCopyCapture.files);
    }

    selectCopyCapture = prevCapture;
    Lampa.Utils.copyTextToClipboard = originalCopy;

    return captured;
  }

  // Проверяет, похоже ли значение на прямой видео/stream URL.
  function isProbablyVideoUrl(value) {
    if (!value) return false;

    let s = String(value);
    try { s = decodeURIComponent(s); } catch (e) {}

    if (/^https?:\/\//i.test(s) && /\/stream\//i.test(s)) return true;
    if (/^https?:\/\//i.test(s) && /player\.html\?/i.test(s) && /[?&]url=/i.test(s)) return true;
    if (/^https?:\/\//i.test(s) && /api\.php\?/i.test(s) && /(proxy=1|prepared_hls=1|url=)/i.test(s)) return true;
    if (/^https?:\/\//i.test(s) && /\.(m3u8|mp4|mkv|avi|webm)(\?|#|$)/i.test(s)) return true;

    return false;
  }

  // Подбирает человеческое название задачи из меню или URL.
  function guessPrepareTitleFromMenu(params, url) {
    /*
     * В меню Lampa текущая Activity часто называется не самим файлом, а разделом:
     * "Торренты", "Файлы", "Действие". Поэтому для очереди подготовки сначала
     * берём имя именно из stream URL. Это особенно важно для серий.
     */
    const urlTitle = guessPrepareTitleFromUrl(url);
    if (urlTitle) return urlTitle;

    const activityTitle = getCurrentActivityTitle();
    if (activityTitle && !isGenericPrepareTitle(activityTitle)) return activityTitle;

    const title = params && params.title ? String(params.title) : '';
    if (title && !isGenericPrepareTitle(title)) return title;

    return 'Видео';
  }

  // Пытается получить название серии/файла из stream URL.
  function guessPrepareTitleFromUrl(url) {
    if (!url) return '';

    let raw = String(url);
    try { raw = decodeURIComponent(raw); } catch (e) {}

    /*
     * Если передали ссылку на наш player.html?url=..., вытаскиваем вложенный
     * исходный TorrServer/video URL и строим название уже по нему.
     */
    try {
      const outer = new URL(raw, location.href);
      const nested = outer.searchParams.get('url');
      if (nested && nested !== raw) {
        const nestedTitle = guessPrepareTitleFromUrl(nested);
        if (nestedTitle) return nestedTitle;
      }
    } catch (e) {}

    try {
      const u = new URL(raw, location.href);
      let name = decodeURIComponent((u.pathname || '').split('/').pop() || '');
      name = name.replace(/\.[a-z0-9]{2,6}$/i, '');
      name = name.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();

      if (name && !isGenericPrepareTitle(name)) return name;
    } catch (e) {}

    return '';
  }

  // Отбрасывает слишком общие заголовки вроде “Торренты” или “Файлы”.
  function isGenericPrepareTitle(title) {
    const s = String(title || '').trim().toLowerCase();
    if (!s) return true;

    return !!{
      'действие': 1,
      'действия': 1,
      'action': 1,
      'actions': 1,
      'торренты': 1,
      'torrents': 1,
      'torrent': 1,
      'файлы': 1,
      'files': 1,
      'файл': 1,
      'file': 1,
      'видео': 1,
      'video': 1,
      'плеер': 1,
      'player': 1
    }[s];
  }

  // Берёт заголовок текущей Activity Lampa как fallback.
  function getCurrentActivityTitle() {
    try {
      const active = window.Lampa && Lampa.Activity && typeof Lampa.Activity.active === 'function'
        ? Lampa.Activity.active()
        : null;

      const movie = active && (active.movie || active.card || active.object);
      const title =
        (active && (active.title || active.name)) ||
        (movie && (movie.title || movie.name || movie.original_title || movie.original_name));

      if (title) return String(title);
    } catch (e) {}

    return '';
  }

  // Показывает пользователю уведомление Lampa/alert о добавлении в очередь.
  function showPrepareMessage(message) {
    try {
      if (window.Lampa && Lampa.Noty && typeof Lampa.Noty.show === 'function') {
        Lampa.Noty.show(message);
        return;
      }
    } catch (e) {}

    console.log('[Lampa Sync]', message);
  }

  // Перехватывает Lampa.Torserver.stream до preload и подменяет готовые файлы на prepared-HLS.
  function installTorserverStreamHook() {
    if (torserverStreamHookInstalled) return true;

    const tor = getTorserverObject();
    if (!tor || typeof tor.stream !== 'function') {
      setTimeout(installTorserverStreamHook, 1000);
      return false;
    }

    originalTorserverStream = tor.stream;
    torserverStreamHookInstalled = true;

    tor.stream = function (path, hash, id) {
      let originalUrl = '';

      try {
        originalUrl = String(originalTorserverStream.apply(this, arguments) || '');
      } catch (e) {
        console.warn('[Lampa Sync] Torserver.stream original failed:', e);
        return originalTorserverStream.apply(this, arguments);
      }

      try {
        const item = findPreparedByTorserverArgs(path, hash, id) || findPreparedFastItem(originalUrl);

        if (item && item.hls_url) {
          console.log('[Lampa Sync] Torserver.stream -> prepared HLS:', {
            torrent_key: item.torrent_key,
            title: item.title,
            original_url: originalUrl,
            hls_url: item.hls_url
          });

          return item.hls_url;
        }
      } catch (e) {
        console.warn('[Lampa Sync] Torserver.stream prepared hook failed:', e);
      }

      return originalUrl;
    };

    console.log('[Lampa Sync] Torserver.stream hook installed');
    return true;
  }

  // Находит объект TorrServer в разных вариантах сборки Lampa.
  function getTorserverObject() {
    if (!window.Lampa) return null;
    return Lampa.Torserver || Lampa.Torrserver || Lampa.TorrServer || null;
  }

  // Ищет готовую задачу по аргументам path/hash/index из Torserver.stream.
  function findPreparedByTorserverArgs(path, hash, id) {
    const hp = makeHashPathKey(hash, path);
    if (hp && preparedFastByHashPath[hp]) return preparedFastByHashPath[hp];

    const key = makeTorrentKey(hash, id);
    const item = key && preparedFastByTorrent[key] ? preparedFastByTorrent[key] : null;

    /*
     * В Lampa/TorrServer индекс файла иногда может отличаться от того, что мы
     * ожидаем, а path почти всегда указывает на конкретный файл/серию. Поэтому
     * по hash:index открываем prepared-HLS только если stream_path совпадает
     * с path или если stream_path у записи вообще неизвестен. Это защищает от
     * ситуации, когда серия открывает HLS соседней серии/сборника с другой
     * длительностью.
     */
    if (item) {
      if (!item.stream_path || pathsEqual(item.stream_path, path)) return item;
      console.warn('[Lampa Sync] prepared torrent_key matched but path differs, skip:', {
        torrent_key: key,
        lampa_path: path,
        prepared_path: item.stream_path,
        title: item.title
      });
    }

    return null;
  }

  // Создаёт ключ hash:index для файла внутри торрента.
  function makeTorrentKey(hash, id) {
    hash = String(hash === null || hash === undefined ? '' : hash).toLowerCase().replace(/[^a-z0-9]/g, '');
    const index = parseInt(String(id === null || id === undefined ? '' : id).replace(/[^0-9-]/g, ''), 10);

    if (!hash || !isFinite(index) || index < 0) return '';
    return hash + ':' + index;
  }

  // Нормализует путь файла, чтобы сравнение серий было устойчивее.
  function normalizeStreamPathForMatch(value) {
    if (!value) return '';
    let s = String(value);
    try { s = decodeURIComponent(s); } catch (e) {}

    try {
      const u = new URL(s, location.href);
      s = u.pathname || s;
    } catch (e) {}

    s = s.replace(/^\/stream\//i, '');
    s = s.split('?')[0].split('#')[0];
    s = s.replace(/^\/+|\/+$/g, '').toLowerCase();
    return s;
  }

  // Сравнивает пути файлов внутри торрента после нормализации.
  function pathsEqual(a, b) {
    const aa = normalizeStreamPathForMatch(a);
    const bb = normalizeStreamPathForMatch(b);
    if (!aa || !bb) return false;
    return aa === bb || aa.endsWith('/' + bb) || bb.endsWith('/' + aa);
  }

  // Создаёт дополнительный ключ hash+path для защиты от неверного index.
  function makeHashPathKey(hash, path) {
    hash = String(hash === null || hash === undefined ? '' : hash).toLowerCase().replace(/[^a-z0-9]/g, '');
    const p = normalizeStreamPathForMatch(path);
    if (!hash || !p) return '';
    return hash + '|' + p;
  }

  // Ранний DOM-перехват как дополнительная страховка, если URL всё же доступен в элементе.
  function handlePreparedFastClick(event) {
    if (overlay || opening) return;
    if (event.defaultPrevented) return;

    const target = event.target;
    const streamUrl = extractStreamUrlFromDom(target);

    if (!streamUrl) return;

    const item = findPreparedFastItem(streamUrl);
    if (!item) {
      refreshPreparedFastIndex(true);
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();

    const title = item.title || getDomTitle(target) || 'Видео';
    const progressContentId = getContentId({}, streamUrl);
    const contentId = item.content_id || progressContentId || ('stream_' + simpleHash(item.normalized_url || streamUrl));
    const progressAltIds = buildProgressAltIds(progressContentId, streamUrl, streamUrl, item);

    currentPlayback = {
      data: {},
      streamUrl: streamUrl,
      title: title,
      contentId: progressContentId || contentId,
      mediaContentId: contentId,
      openedAt: Date.now(),
      preparedFastOpen: true
    };

    const playerUrl =
      PLAYER_URL +
      '?url=' + encodeURIComponent(streamUrl) +
      '&title=' + encodeURIComponent(title) +
      '&content_id=' + encodeURIComponent(contentId) +
      '&progress_content_id=' + encodeURIComponent(progressContentId || contentId) +
      '&progress_alt_ids=' + encodeURIComponent(progressAltIds.join(',')) +
      '&transcode=1' +
      '&prepared=1' +
      '&quality=' + encodeURIComponent(QUALITY) +
      '&v=' + Date.now();

    openOverlay(playerUrl, title);
  }

  // Ищет готовую задачу по URL, HLS URL или torrent_key.
  function findPreparedFastItem(streamUrl) {
    const key = preparedUrlKey(streamUrl);
    if (!key) return null;

    if (preparedFastByHls[key]) return preparedFastByHls[key];

    const torrentKey = torrentKeyFromUrl(streamUrl);
    if (torrentKey && preparedFastByTorrent[torrentKey]) return preparedFastByTorrent[torrentKey];

    for (let i = 0; i < preparedFastIndex.length; i++) {
      const item = preparedFastIndex[i];
      if (item.source_key && item.source_key === key) return item;
      if (item.normalized_key && item.normalized_key === key) return item;
      if (item.hls_key && item.hls_key === key) return item;
    }

    return null;
  }

  // Извлекает hash:index из TorrServer stream URL.
  function torrentKeyFromUrl(url) {
    if (!url) return '';

    try { url = decodeURIComponent(String(url)); }
    catch (e) { url = String(url); }

    let u;
    try { u = new URL(url, location.href); }
    catch (e) { return ''; }

    const hash = (u.searchParams.get('link') || u.searchParams.get('hash') || u.searchParams.get('torrent') || u.searchParams.get('torrent_hash') || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const indexRaw = u.searchParams.get('index') || u.searchParams.get('id') || u.searchParams.get('file') || u.searchParams.get('file_index') || '';
    const index = parseInt(String(indexRaw).replace(/[^0-9-]/g, ''), 10);

    if (!hash || !isFinite(index) || index < 0) return '';
    return hash + ':' + index;
  }

  // Пытается найти stream URL в DOM-элементе и связанных данных.
  function extractStreamUrlFromDom(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    let depth = 0;

    while (el && depth < 8) {
      const values = [];

      try {
        if (el.href) values.push(el.href);
        if (el.src) values.push(el.src);
        if (el.title) values.push(el.title);
        if (el.dataset) {
          Object.keys(el.dataset).forEach(function (k) {
            values.push(el.dataset[k]);
          });
        }
        ['href', 'src', 'data-url', 'data-link', 'data-file', 'data-stream', 'data-json', 'data-torrent', 'title'].forEach(function (name) {
          const v = el.getAttribute && el.getAttribute(name);
          if (v) values.push(v);
        });
      } catch (e) {}

      for (let i = 0; i < values.length; i++) {
        const found = findStreamUrlInText(values[i]);
        if (found) return found;
      }

      el = el.parentElement;
      depth++;
    }

    return '';
  }

  // Ищет stream URL внутри строки.
  function findStreamUrlInText(value) {
    if (!value) return '';
    let s = String(value);

    try {
      const parsed = JSON.parse(s);
      const fromJson = findStreamUrlInObject(parsed, 0);
      if (fromJson) return fromJson;
    } catch (e) {}

    try { s = decodeURIComponent(s); } catch (e) {}

    const m = s.match(/https?:\/\/[^\s"'<>]+\/stream\/[^\s"'<>]+/i) || s.match(/https?:\/\/[^\s"'<>]+(?:url=)[^\s"'<>]+/i);
    if (!m) return '';

    let url = m[0].replace(/[),.;]+$/g, '');

    if (url.indexOf('player.html') >= 0 || url.indexOf('api.php') >= 0) {
      try {
        const u = new URL(url, location.href);
        const nested = u.searchParams.get('url') || u.searchParams.get('src') || u.searchParams.get('source');
        if (nested) return nested;
      } catch (e) {}
    }

    return url;
  }

  // Рекурсивно ищет stream URL внутри JS-объекта.
  function findStreamUrlInObject(value, depth) {
    if (!value || depth > 4) return '';
    if (typeof value === 'string') return findStreamUrlInText(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const found = findStreamUrlInObject(value[i], depth + 1);
        if (found) return found;
      }
      return '';
    }
    if (typeof value === 'object') {
      const preferred = ['url', 'file', 'link', 'stream', 'video', 'src'];
      for (let i = 0; i < preferred.length; i++) {
        if (value[preferred[i]]) {
          const found = findStreamUrlInObject(value[preferred[i]], depth + 1);
          if (found) return found;
        }
      }
      const keys = Object.keys(value);
      for (let j = 0; j < keys.length; j++) {
        const found = findStreamUrlInObject(value[keys[j]], depth + 1);
        if (found) return found;
      }
    }
    return '';
  }

  // Нормализует URL для сравнения prepared/cache записей.
  function preparedUrlKey(url) {
    if (!url) return '';

    try {
      url = decodeURIComponent(String(url));
    } catch (e) {
      url = String(url);
    }

    let u;
    try {
      u = new URL(url, location.href);
    } catch (e) {
      return url;
    }

    const keys = [];
    u.searchParams.forEach(function (value, key) {
      key = String(key || '').toLowerCase().replace(/\.+$/g, '');
      if (!key) return;
      if ({preload:1, stat:1, m3u:1, fromlast:1, save:1, play:1, start:1, time:1, position:1, pos:1, seek:1}[key]) return;
      keys.push([key, value]);
    });

    keys.sort(function (a, b) {
      return a[0] === b[0] ? String(a[1]).localeCompare(String(b[1])) : a[0].localeCompare(b[0]);
    });

    return [
      u.pathname || '',
      keys.map(function (kv) { return kv[0] + '=' + kv[1]; }).join('&')
    ].join('?');
  }

  // Пытается получить название фильма/серии из DOM.
  function getDomTitle(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    let depth = 0;
    while (el && depth < 5) {
      const txt = (el.innerText || el.textContent || '').trim();
      if (txt && txt.length < 180) return txt.replace(/\s+/g, ' ');
      el = el.parentElement;
      depth++;
    }
    return '';
  }

  // ---------------------------------------------------------------------------
  // Player progress -> Lampa native Timeline API.
  // ---------------------------------------------------------------------------

  // Принимает прогресс из player.html и обновляет Timeline/историю Lampa.
  function updateLampaProgress(progress) {
    if (!progress || typeof progress !== 'object') return;

    const position = Math.max(0, Number(progress.position || 0));
    const duration = Math.max(0, Number(progress.duration || 0));

    if (!duration || !isFinite(duration)) return;

    const percent = Math.max(0, Math.min(100, Number(progress.percent || Math.round(position / duration * 100))));
    const ended = !!progress.ended || percent >= 95;

    const timeline = buildLampaTimeline(progress, position, duration, percent);
    const changedKeys = [];

    if (timeline) {
      const data = currentPlayback && currentPlayback.data ? currentPlayback.data : {};
      const hashCandidates = getTimelineHashCandidates(data, progress, timeline);
      const timelineRuntimeUpdated = updateViaLampaTimeline(timeline);
      const timelineStorageUpdated = ensureTimelineInLocalStorageForHashes(hashCandidates, timeline);

      if (timelineStorageUpdated || timelineRuntimeUpdated) {
        changedKeys.push('file_view');
        changedKeys.push('file_view_' + getProfileId());
        discoverAndAddLocalStorageKeys();
      }

      if (logEnabled()) {
        console.log('[Lampa Sync] player progress -> timeline:', {
          position: position,
          duration: duration,
          percent: percent,
          hashes: hashCandidates,
          storageUpdated: timelineStorageUpdated,
          runtimeUpdated: timelineRuntimeUpdated
        });
      }
    }

    updateLampaHistoryAndViewed(ended);

    if (changedKeys.length) {
      /*
       * Do not force-refresh Lampa UI on every local player progress tick.
       * On phones this can cause a visible refresh loop because player.html sends
       * progress every few seconds. Lampa/runtime storage notifications are enough
       * for local playback; explicit UI refresh is reserved for remote server data.
       */
      markLocalKeysChanged(unique(changedKeys));
    }
  }

  // Собирает объект timeline в формате, который понимает Lampa.
  function buildLampaTimeline(progress, position, duration, percent) {
    const data = currentPlayback && currentPlayback.data ? currentPlayback.data : {};
    const existing = data.timeline && typeof data.timeline === 'object' ? data.timeline : null;
    const hash = getTimelineHash(data, progress);

    let timeline = null;

    if (existing) {
      timeline = clonePlain(existing);
    } else if (hash && window.Lampa && Lampa.Timeline && typeof Lampa.Timeline.view === 'function') {
      try {
        timeline = Lampa.Timeline.view(hash);
      } catch (e) {
        timeline = null;
      }
    }

    if (!timeline || typeof timeline !== 'object') {
      if (!hash) return null;
      timeline = {};
    }

    if (hash) {
      timeline.hash = hash;
      timeline.id = hash;
    }

    timeline.time = position;
    timeline.sec = position;
    timeline.position = position;
    timeline.duration = duration;
    timeline.percent = percent;
    timeline.profile = normalizeProfileId(getProfileId());

    return timeline;
  }

  // Пытается обновить прогресс через нативный Lampa.Timeline API.
  function updateViaLampaTimeline(timeline) {
    try {
      if (!window.Lampa || !Lampa.Timeline || typeof Lampa.Timeline.update !== 'function') {
        return false;
      }

      Lampa.Timeline.update(timeline);

      if (logEnabled()) {
        console.log('[Lampa Sync] Timeline.update:', timeline);
      }

      return true;
    } catch (e) {
      console.warn('[Lampa Sync] Timeline.update failed:', e);
      return false;
    }
  }

  // Сохраняет timeline сразу под несколькими возможными hash.
  function ensureTimelineInLocalStorageForHashes(hashes, timeline) {
    const list = unique((hashes || []).filter(Boolean));
    let changed = false;

    list.forEach(function (hash) {
      if (ensureTimelineInLocalStorage(hash, timeline)) {
        changed = true;
      }
    });

    return changed;
  }

  // Записывает один timeline в file_view и file_view_<profile>.
  function ensureTimelineInLocalStorage(hash, timeline) {
    const profileId = normalizeProfileId(getProfileId());
    const payload = normalizeTimelineItem(Object.assign({}, timeline, { profile: profileId }));

    if (!hash || !payload || isSyntheticTimelineHash(hash)) return false;

    const nativePayload = makeNativeTimelinePayload(payload, profileId);
    let changed = false;

    getFileViewMirrorKeys('file_view_' + profileId).forEach(function (key) {
      const before = localStorage.getItem(key) || '';
      let obj = safeParse(before);
      let keyChanged = false;

      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        obj = {};
        keyChanged = !!before;
      }

      const cleanup = cleanupFileViewObject(obj);
      obj = cleanup.obj;
      if (cleanup.changed) keyChanged = true;

      const prev = normalizeTimelineItem(obj[hash]);

      if (!prev || shouldUseServerTimeline(prev, payload) || shouldUseLocalTimeline(payload, prev)) {
        obj[hash] = nativePayload;
        keyChanged = true;
      }

      if (keyChanged && setStorageRaw(key, JSON.stringify(obj))) {
        changed = true;
      }
    });

    if (changed && logEnabled()) {
      console.log('[Lampa Sync] file_view stored native:', hash, nativePayload);
    }

    return changed;
  }
  function updateTimelineStorageFallback(hash, timeline) {
    return ensureTimelineInLocalStorage(hash, timeline);
  }

  // Выбирает основной hash для текущего видео.
  function getTimelineHash(data, progress) {
    const candidates = getTimelineHashCandidates(data, progress, null);
    return candidates.length ? candidates[0] : null;
  }

  // Собирает все возможные hash-кандидаты из данных Lampa и player.html.
  function getTimelineHashCandidates(data, progress, timeline) {
    const candidates = [];
    function add(v) {
      if (v === null || v === undefined || v === '') return;
      const s = String(v);
      if (!s || candidates.indexOf(s) >= 0) return;
      candidates.push(s);
    }

    const t = timeline && typeof timeline === 'object' ? timeline : null;

    if (t) {
      add(t.hash);
      add(t.id);
      add(t.timeline);
      add(t.key);
    }

    if (data && data.timeline && typeof data.timeline === 'object') {
      add(data.timeline.hash);
      add(data.timeline.id);
      add(data.timeline.timeline);
      add(data.timeline.key);
    }

    add(data && data.hash_timeline);
    add(data && data.timeline_hash);
    add(data && data.hash);
    add(progress && progress.hash_timeline);
    add(progress && progress.timeline_hash);
    add(progress && progress.hash);

    const hashSource = getTimelineHashSource(data || {});

    if (hashSource && window.Lampa && Lampa.Utils && typeof Lampa.Utils.hash === 'function') {
      try { add(Lampa.Utils.hash(hashSource)); } catch (e) {}
    }

    return candidates.filter(function (hash) {
      return !isSyntheticTimelineHash(hash);
    });
  }

  // Формирует исходную строку, из которой Lampa обычно считает hash таймлайна.
  function getTimelineHashSource(data) {
    const movie = data.movie || data.card || data.object || {};
    const season = getSeasonNumber(data);
    const episode = getEpisodeNumber(data);

    const original =
      movie.original_title ||
      movie.original_name ||
      data.original_title ||
      data.original_name ||
      movie.title ||
      movie.name ||
      data.title ||
      data.name ||
      (currentPlayback && currentPlayback.title);

    if (!original) return '';

    if (season && episode) {
      return [
        season,
        Number(season) > 10 ? ':' : '',
        episode,
        original
      ].join('');
    }

    return String(original);
  }

  // Обновляет историю и отметку “просмотрено” внутри Lampa.
  function updateLampaHistoryAndViewed(ended) {
    const data = currentPlayback && currentPlayback.data ? currentPlayback.data : {};
    const movie = data.movie || data.card || data.object || null;

    try {
      if (movie && movie.id && window.Lampa && Lampa.Favorite && typeof Lampa.Favorite.add === 'function') {
        Lampa.Favorite.add('history', movie, 100);
      }
    } catch (e) {}

    if (!ended) return;

    try {
      if (data && typeof data.callback === 'function') data.callback();
      else if (data && typeof data.mark === 'function') data.mark();
    } catch (e) {}
  }

  // Применяет полученные с сервера ключи к runtime Lampa.
  function applyRemoteKeysToLampaRuntime(keys) {
    if (!keys || !keys.length) return;

    const hasTimelineKeys = keys.some(function (key) {
      return key === 'file_view' || key.indexOf('file_view_') === 0;
    });

    if (hasTimelineKeys) {
      hydrateTimelinesFromLocalStorage(keys);
    }

    const hasHistoryKeys = keys.some(function (key) {
      return key === 'online_watched_last' || key === 'online_watched_list';
    });

    if (hasHistoryKeys) {
      notifyStorageChanged('online_watched_last', '', localStorage.getItem('online_watched_last') || '');
      notifyStorageChanged('online_watched_list', '', localStorage.getItem('online_watched_list') || '');
    }

    if (keys.indexOf('activity') >= 0 && ACTIVITY_RUNTIME_APPLY) {
      applyPendingRemoteActivity();
    }
  }

  // Применяет удалённый activity только как защищённую remote-команду.
  function applyPendingRemoteActivity(forceApply) {
    const packet = pendingRemoteActivityPacket;
    forceApply = !!forceApply;

    if (!packet || !packet.raw) return;

    const token = packet.token || buildActivityRemoteToken(packet.serverTs, packet.originDevice, packet.fp);

    if (token && token === lastRemoteActivityAppliedToken) {
      pendingRemoteActivityPacket = null;
      pendingRemoteActivityRaw = '';
      return;
    }

    if (!ACTIVITY_RUNTIME_APPLY || (!forceApply && !canApplyRemoteActivity(packet.raw))) {
      pendingRemoteActivityRaw = packet.raw;
      return;
    }

    pendingRemoteActivityPacket = null;
    pendingRemoteActivityRaw = '';

    if ((localStorage.getItem('activity') || '') !== packet.raw) {
      setRaw('activity', packet.raw);
    }

    lastAppliedActivityRaw = packet.raw;
    lastAppliedActivityFingerprint = packet.fp || activityFingerprint(packet.raw);
    lastRemoteActivityAppliedToken = token;
    lastActivityRuntimeAppliedAt = Date.now();
    suppressActivityPushUntil = Date.now() + ACTIVITY_ECHO_SUPPRESS_MS;

    const activity = extractActivityObject(safeParse(packet.raw));

    if (logEnabled()) {
      console.log('[Lampa Sync] remote activity apply:', {
        originDevice: packet.originDevice,
        serverTs: packet.serverTs,
        activity: activity || packet.raw
      });
    }

    if (activity && shouldReplaceActivity(activity)) {
      forceApplyActivity(activity);
    }

    lastRawSnapshot = captureRawSnapshot();
  }

  // Пробует открыть activity через доступные методы Lampa.Activity.
  function forceApplyActivity(activity) {
    let used = false;

    const tryMethod = function (target, name, args) {
      try {
        if (target && typeof target[name] === 'function') {
          target[name].apply(target, args || []);
          used = true;
          return true;
        }
      } catch (e) {
        if (logEnabled()) console.warn('[Lampa Sync] activity method failed:', name, e);
      }

      return false;
    };

    if (window.Lampa && Lampa.Activity) {
      tryMethod(Lampa.Activity, 'replace', [activity]);
      if (!used) tryMethod(Lampa.Activity, 'push', [activity]);
      if (!used) tryMethod(Lampa.Activity, 'open', [activity]);
      if (!used) tryMethod(Lampa.Activity, 'start', [activity]);
      if (!used) tryMethod(Lampa.Activity, 'change', [activity]);
    }

    if (logEnabled()) {
      console.log('[Lampa Sync] remote activity applied, usedMethod:', used, activity);
    }
  }

  // Достаёт activity-объект из разных форматов localStorage.
  function extractActivityObject(value) {
    if (typeof value === 'string') {
      value = safeParse(value);
    }

    if (!value) return null;

    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) {
        const item = value[i];

        if (item && typeof item === 'object') {
          return item;
        }
      }

      return null;
    }

    if (typeof value === 'object') {
      if (value.active && typeof value.active === 'object') return value.active;
      if (value.current && typeof value.current === 'object') return value.current;
      if (value.activity && typeof value.activity === 'object') return value.activity;
      return value;
    }

    return null;
  }

  // Проверяет, достаточно ли объект похож на activity Lampa.
  function shouldReplaceActivity(activity) {
    if (!activity || typeof activity !== 'object') return false;

    /*
     * Lampa.Activity.replace expects an activity-like object.
     * These fields are common for Lampa screens.
     */
    return !!(
      activity.component ||
      activity.url ||
      activity.search ||
      activity.source ||
      activity.card ||
      activity.movie ||
      activity.page ||
      activity.method ||
      activity.params ||
      activity.title ||
      activity.object
    );
  }

  // Загружает таймлайны из localStorage обратно в runtime Lampa.
  function hydrateTimelinesFromLocalStorage(keys) {
    const profileId = normalizeProfileId(getProfileId());
    const wanted = unique(
      (keys || [])
        .filter(function (key) {
          return key === 'file_view' || key.indexOf('file_view_') === 0;
        })
        .concat(['file_view', 'file_view_' + profileId])
    );

    const seenHashes = {};

    wanted.forEach(function (storageKey) {
      const raw = localStorage.getItem(storageKey) || '';
      const data = safeParse(raw);

      if (!data || typeof data !== 'object' || Array.isArray(data)) return;

      Object.keys(data).forEach(function (hash) {
        if (!hash || seenHashes[hash] || isSyntheticTimelineHash(hash)) return;

        const value = data[hash];

        if (!value || typeof value !== 'object' || Array.isArray(value)) return;

        // Ignore bad v6.5-db-sync objects like id_1/url_.../title/position.
        if (!('time' in value) && !('duration' in value) && !('percent' in value)) return;

        seenHashes[hash] = true;

        const timeline = Object.assign({}, value, {
          hash: hash,
          id: hash
        });

        if (!timeline.profile && timeline.profile !== 0) {
          timeline.profile = profileId;
        }

        try {
          if (window.Lampa && Lampa.Timeline && typeof Lampa.Timeline.update === 'function') {
            Lampa.Timeline.update(timeline);
          }
        } catch (e) {
          if (logEnabled()) console.warn('[Lampa Sync] Timeline.update from server failed:', e);
        }
      });
    });

    if (logEnabled()) {
      console.log('[Lampa Sync] hydrated timelines from storage:', Object.keys(seenHashes));
    }
  }

  // Мягко обновляет видимые карточки/прогресс после remote sync.
  function refreshLampaUi(keys, remoteApplied) {
    const list = unique((keys || []).filter(Boolean));

    if (!list.length) return;

    const hasTimelineKeys = list.some(function (key) {
      return key === 'file_view' || key.indexOf('file_view_') === 0;
    });

    const hasHistoryKeys = list.some(function (key) {
      return key === 'online_watched_last' || key === 'online_watched_list';
    });

    const hasActivityKeys = list.indexOf('activity') >= 0;

    /*
     * UI refresh policy:
     *
     * - file_view / file_view_<profile>:
     *   Only update Lampa timeline runtime and visible time bars. Do not call
     *   Activity.render/refresh/update, otherwise a single progress update can
     *   redraw the whole film card or visible list.
     *
     * - online_watched_*:
     *   Only emit lightweight storage notifications.
     *
     * - activity:
     *   Remote navigation is a separate command and may refresh the current
     *   activity after Lampa.Activity.* was called.
     */
    const signature = (remoteApplied ? 'remote:' : 'local:') + list.slice().sort().join(',');
    const now = Date.now();
    const minInterval = remoteApplied ? 700 : 5000;

    if (signature === lastUiRefreshSignature && now - lastUiRefreshAt < minInterval) {
      return;
    }

    lastUiRefreshSignature = signature;
    lastUiRefreshAt = now;

    const notifyOnce = function () {
      if (hasTimelineKeys) {
        try {
          if (window.Lampa && Lampa.Timeline && Lampa.Timeline.listener && Lampa.Timeline.listener.send) {
            Lampa.Timeline.listener.send('update', { keys: list, remote: !!remoteApplied });
          }
        } catch (e) {}

        try {
          if (window.Lampa && Lampa.Listener && Lampa.Listener.send) {
            list.forEach(function (key) {
              if (key === 'file_view' || key.indexOf('file_view_') === 0) {
                Lampa.Listener.send('storage', { name: key, key: key, remote: !!remoteApplied });
              }
            });
            Lampa.Listener.send('timeline', { type: 'update', keys: list, remote: !!remoteApplied });
          }
        } catch (e) {}

        patchVisibleTimelineBars(list);
      }

      if (hasHistoryKeys) {
        try {
          if (window.Lampa && Lampa.Listener && Lampa.Listener.send) {
            if (list.indexOf('online_watched_last') >= 0) {
              Lampa.Listener.send('storage', { name: 'online_watched_last', key: 'online_watched_last', remote: !!remoteApplied });
            }

            if (list.indexOf('online_watched_list') >= 0) {
              Lampa.Listener.send('storage', { name: 'online_watched_list', key: 'online_watched_list', remote: !!remoteApplied });
            }
          }
        } catch (e) {}
      }
    };

    notifyOnce();

    if (remoteApplied) {
      /*
       * A second lightweight pass helps if Lampa updates the active card/list
       * a little later after localStorage was changed. This still does not call
       * Activity.render/refresh/update for timeline-only changes.
       */
      if (hasTimelineKeys) {
        setTimeout(function () {
          hydrateTimelinesFromLocalStorage(list);
          patchVisibleTimelineBars(list);
        }, 250);
      }

      /*if (hasActivityKeys) {
        applyPendingRemoteActivity();
      }*/
    }

    if (logEnabled()) {
      console.log('[Lampa Sync] lightweight UI notify:', list, 'remote:', !!remoteApplied);
    }
  }

  // Патчит видимые полосы прогресса без полного reload интерфейса.
  function patchVisibleTimelineBars(keys) {
    const items = collectTimelineItemsFromLocalStorage(keys);
    const hashes = Object.keys(items);

    if (!hashes.length || !document || !document.querySelectorAll) return;

    hashes.forEach(function (hash) {
      const item = items[hash];
      const percent = Math.max(0, Math.min(100, Number(item.percent || 0)));
      const escapedHash = cssEscape(hash);
      const selectors = [
        '.time-line[data-hash="' + escapedHash + '"]',
        '[data-hash="' + escapedHash + '"] .time-line',
        '[data-timeline="' + escapedHash + '"] .time-line',
        '[data-id="' + escapedHash + '"] .time-line'
      ];

      selectors.forEach(function (selector) {
        let nodes = [];

        try {
          nodes = Array.prototype.slice.call(document.querySelectorAll(selector));
        } catch (e) {
          nodes = [];
        }

        nodes.forEach(function (node) {
          patchTimelineElement(node, percent);
        });
      });
    });

    if (logEnabled()) {
      console.log('[Lampa Sync] patched visible timeline bars:', hashes);
    }
  }

  // Собирает timeline-элементы из file_view localStorage.
  function collectTimelineItemsFromLocalStorage(keys) {
    const profileId = normalizeProfileId(getProfileId());
    const wanted = unique(
      (keys || [])
        .filter(function (key) {
          return key === 'file_view' || key.indexOf('file_view_') === 0;
        })
        .concat(['file_view', 'file_view_' + profileId])
    );

    const out = {};

    wanted.forEach(function (storageKey) {
      const raw = localStorage.getItem(storageKey) || '';
      const data = safeParse(raw);

      if (!data || typeof data !== 'object' || Array.isArray(data)) return;

      Object.keys(data).forEach(function (hash) {
        if (!hash || isSyntheticTimelineHash(hash)) return;

        const item = normalizeTimelineItem(data[hash]);
        if (!item) return;

        const prev = out[hash];

        if (!prev || shouldUseServerTimeline(prev, item) || shouldUseLocalTimeline(item, prev)) {
          out[hash] = item;
        }
      });
    });

    return out;
  }

  // Обновляет один DOM-элемент прогресса.
  function patchTimelineElement(node, percent) {
    if (!node || !node.style) return;

    const width = percent.toFixed(2).replace(/\.00$/, '') + '%';

    try {
      node.setAttribute('data-percent', String(Math.round(percent)));
      node.style.setProperty('--lampa-sync-percent', width);
    } catch (e) {}

    /*
     * Different Lampa builds/plugins use slightly different markup for progress
     * bars. We patch only obvious inner-fill elements. If there is no inner fill,
     * we avoid changing the root element width so the layout does not jump.
     */
    const fillSelectors = [
      '.time-line__fill',
      '.time-line__progress',
      '.time-line__value',
      '.time-line__line',
      '.time-line__bar',
      '.line',
      '.progress',
      '.fill',
      'span',
      'i'
    ];

    let patched = false;

    for (let i = 0; i < fillSelectors.length; i++) {
      let fill = null;

      try {
        fill = node.querySelector && node.querySelector(fillSelectors[i]);
      } catch (e) {
        fill = null;
      }

      if (fill && fill !== node && fill.style) {
        try {
          fill.style.width = width;
          fill.style.maxWidth = '100%';
          patched = true;
        } catch (e) {}
      }
    }

    if (!patched) {
      try {
        node.style.backgroundSize = width + ' 100%';
      } catch (e) {}
    }
  }
  function cssEscape(value) {
    value = String(value || '');

    if (window.CSS && typeof window.CSS.escape === 'function') {
      try { return window.CSS.escape(value); } catch (e) {}
    }

    return value.replace(/["\\]/g, '\\$&');
  }
  function softRefreshCurrentActivity() {
    try {
      const active = window.Lampa && Lampa.Activity && Lampa.Activity.active && Lampa.Activity.active();

      tryCall(active, ['refresh', 'update', 'render']);
      tryCall(active && active.activity, ['refresh', 'update', 'render']);
      tryCall(active && active.component, ['refresh', 'update', 'render']);
      tryCall(active && active.object, ['refresh', 'update', 'render']);
      tryCall(active && active.card, ['refresh', 'update', 'render']);

      if (window.Lampa && Lampa.Controller && Lampa.Controller.collection && Lampa.Controller.collection().render) {
        Lampa.Controller.collection().render();
      }
    } catch (e) {}

    try { window.dispatchEvent(new Event('resize')); } catch (e) {}
  }
  function tryCall(target, methodNames) {
    if (!target) return;

    methodNames.forEach(function (name) {
      try {
        if (target && typeof target[name] === 'function') {
          target[name]();
        }
      } catch (e) {}
    });
  }
  function normalizeProfileId(v) {
    const n = Number(v || 0);
    return isFinite(n) ? n : 0;
  }
  function clonePlain(obj) {
    const out = {};

    Object.keys(obj || {}).forEach(function (key) {
      const value = obj[key];

      if (typeof value !== 'function') {
        out[key] = value;
      }
    });

    return out;
  }
  function unique(list) {
    const seen = {};
    const out = [];

    (list || []).forEach(function (item) {
      if (!item || seen[item]) return;
      seen[item] = true;
      out.push(item);
    });

    return out;
  }


  // ---------------------------------------------------------------------------
  // Clean localStorage sync v8.
  //
  // The sync layer does not decide how Lampa stores watch progress. Lampa/player
  // writes localStorage, this module only detects changed keys, sends changed raw
  // strings to the server, and applies newer server values from other devices.
  // ---------------------------------------------------------------------------

  const SYNC_PROFILE_KEY_TEMPLATES = [
    'file_view_{profile}'
  ];

  const SYNC_ADDITIONAL_KEYS_SETTING = STORAGE_SYNC_PLUGIN_ID + '_extra_keys';
  const SYNC_CURSOR_PREFIX = STORAGE_SYNC_META_KEY + '_scope_';
  const SYNC_PUSH_DEBOUNCE_MS = PUSH_DEBOUNCE_MS;
  const SYNC_PULL_MS = SERVER_META_POLL_MS;
  const SYNC_LOCAL_POLL_MS = LOCAL_POLL_MS;
  const SYNC_BOOTSTRAP_LOCAL_AFTER_PULL = true;
  const SYNC_HOOK_LOCALSTORAGE_WRITES = true;

  let storageKeySet = {};
  let pushInFlight = false;
  let applyingRemote = false;
  let storageHookInstalled = false;

  // Добавляет настройки плагина в меню Lampa, если API настроек доступен.
  function installSettings() {
    try {
      if (!Lampa.SettingsApi || !Lampa.SettingsApi.addComponent) return;

      Lampa.SettingsApi.addComponent({
        component: STORAGE_SYNC_PLUGIN_ID,
        name: 'Lampa Sync'
      });

      Lampa.SettingsApi.addParam({
        component: STORAGE_SYNC_PLUGIN_ID,
        param: 'enabled',
        type: 'toggle',
        name: 'Синхронизация Lampa localStorage',
        default: true
      }, function (v) {
        try { Lampa.Storage.set(STORAGE_SYNC_PLUGIN_ID + '_enabled', !!v); } catch (e) {}
      });

      Lampa.SettingsApi.addParam({
        component: STORAGE_SYNC_PLUGIN_ID,
        param: 'api',
        type: 'input',
        name: 'URL sync API',
        default: STORAGE_SYNC_API_URL
      }, function (v) {
        if (typeof v === 'string' && v.trim()) {
          try { Lampa.Storage.set(STORAGE_SYNC_PLUGIN_ID + '_api', v.trim()); } catch (e) {}
        }
      });

      Lampa.SettingsApi.addParam({
        component: STORAGE_SYNC_PLUGIN_ID,
        param: 'extra_keys',
        type: 'input',
        name: 'Дополнительные ключи localStorage через запятую',
        default: ''
      }, function (v) {
        try { Lampa.Storage.set(SYNC_ADDITIONAL_KEYS_SETTING, String(v || '').trim()); } catch (e) {}
      });

      Lampa.SettingsApi.addParam({
        component: STORAGE_SYNC_PLUGIN_ID,
        param: 'log',
        type: 'toggle',
        name: 'Логи Lampa Sync в консоль',
        default: false
      }, function (v) {
        try { Lampa.Storage.set(STORAGE_SYNC_PLUGIN_ID + '_log', !!v); } catch (e) {}
      });
    } catch (e) {}
  }

  // Возвращает URL progress.php из настроек плагина.
  function getSyncApiUrl() {
    try { return Lampa.Storage.get(STORAGE_SYNC_PLUGIN_ID + '_api', STORAGE_SYNC_API_URL); }
    catch (e) { return STORAGE_SYNC_API_URL; }
  }

  // Проверяет, включена ли синхронизация localStorage.
  function syncEnabled() {
    try { return Lampa.Storage.get(STORAGE_SYNC_PLUGIN_ID + '_enabled', true); }
    catch (e) { return true; }
  }

  // Проверяет, включены ли debug-логи плагина.
  function logEnabled() {
    try { return Lampa.Storage.get(STORAGE_SYNC_PLUGIN_ID + '_log', false); }
    catch (e) { return false; }
  }

  // Ждёт user/profile id и запускает синхронизацию localStorage.
  function startStorageSyncWhenReady() {
    if (storageSyncStarted || !syncEnabled()) return;
    storageSyncStarted = true;

    const run = function () {
      startStorageSync().catch(function (e) {
        console.error('[Lampa Sync] storage sync start error:', e);
      });
    };

    try {
      if (Lampa.Listener && Lampa.Listener.follow) {
        Lampa.Listener.follow('app', function (e) {
          if (e && e.type === 'ready') run();
        });
        setTimeout(run, 3000);
      } else {
        run();
      }
    } catch (e) {
      run();
    }
  }
  async function startStorageSync() {
    if (storageCtx) return;

    const ids = await waitForIds();

    if (!ids) {
      console.warn('[Lampa Sync] storage sync: user/profile not found');
      return;
    }

    storageCtx = {
      userId: ids.userId,
      localProfileId: ids.profileId,
      profileId: STORAGE_SYNC_SERVER_PROFILE_ID || ids.profileId || '0',
      deviceId: getStorageDeviceId()
    };

    activityStartupGuardUntil = Date.now() + ACTIVITY_STARTUP_GUARD_MS;
    suppressActivityPushUntil = Math.max(suppressActivityPushUntil, activityStartupGuardUntil);

    initStorageKeys(storageCtx.localProfileId);
    lastRawSnapshot = captureRawSnapshot();

    if (SYNC_HOOK_LOCALSTORAGE_WRITES) installLocalStorageHook();

    /*
     * Startup activity is special. The local Lampa instance may restore and
     * rewrite its old page before sync starts. Do not let that old local
     * activity win. First fetch the current server activity directly, ignoring
     * this device's saved delta cursor, and only then run the normal delta pull.
     */
    await pullServerActivitySnapshot('startup-initial');
    await pullServerChanges(true);

    initialPullDone = true;
    activityStartupGuardUntil = Date.now() + 3000;
    suppressActivityPushUntil = Math.max(suppressActivityPushUntil, activityStartupGuardUntil);

    setTimeout(function () {
      try {
        pullServerActivitySnapshot('startup-repull-1')
          .then(function () { return pullServerChanges(false); })
          .catch(function (e) { if (logEnabled()) console.warn('[Lampa Sync] startup repull 1 failed:', e); });
      } catch (e) {}
    }, ACTIVITY_STARTUP_REPULL_1_MS);

    setTimeout(function () {
      try {
        pullServerActivitySnapshot('startup-repull-2')
          .then(function () { return pullServerChanges(false); })
          .catch(function (e) { if (logEnabled()) console.warn('[Lampa Sync] startup repull 2 failed:', e); });
      } catch (e) {}
    }, ACTIVITY_STARTUP_REPULL_2_MS);

    setInterval(function () {
      try { pollLocalStorage(); } catch (e) { console.error('[Lampa Sync] local poll error:', e); }
    }, SYNC_LOCAL_POLL_MS);

    setInterval(function () {
      pullServerChanges(false);
    }, SYNC_PULL_MS);

    bindFlushHandlers();

    if (logEnabled()) {
      console.log('[Lampa Sync] clean storage sync started:', storageCtx, storageKeys);
    }
  }

  // Создаёт список localStorage-ключей для синхронизации.
  function initStorageKeys(profileId) {
    const keys = [];

    BASE_SYNC_KEYS.forEach(function (key) {
      keys.push(resolveSyncKeyTemplate(key, profileId));
    });

    SYNC_PROFILE_KEY_TEMPLATES.forEach(function (key) {
      keys.push(resolveSyncKeyTemplate(key, profileId));
    });

    readExtraSyncKeys().forEach(function (key) {
      keys.push(resolveSyncKeyTemplate(key, profileId));
    });

    storageKeys = unique(keys.map(normalizeSyncKey).filter(Boolean));
    rebuildStorageKeySet();
  }

  // Читает дополнительные ключи sync из настроек пользователя.
  function readExtraSyncKeys() {
    let raw = '';

    try { raw = Lampa.Storage.get(SYNC_ADDITIONAL_KEYS_SETTING, ''); }
    catch (e) { raw = ''; }

    return String(raw || '')
      .split(',')
      .map(function (key) { return key.trim(); })
      .filter(Boolean);
  }

  // Подставляет profile id в шаблон ключа.
  function resolveSyncKeyTemplate(key, profileId) {
    return String(key || '')
      .replace(/\{profile\}/g, normalizeProfileId(profileId))
      .trim();
  }

  // Очищает имя localStorage-ключа.
  function normalizeSyncKey(key) {
    key = String(key || '').trim();
    if (!key || key === STORAGE_SYNC_META_KEY || key.indexOf(SYNC_CURSOR_PREFIX) === 0) return '';
    if (!/^[a-zA-Z0-9_\-:.]+$/.test(key)) return '';
    return key;
  }

  // Пересобирает Set синхронизируемых ключей.
  function rebuildStorageKeySet() {
    storageKeySet = {};
    storageKeys.forEach(function (key) { storageKeySet[key] = true; });
  }

  // Добавляет новые ключи в sync-набор.
  function addStorageKeys(keys) {
    let changed = false;

    (keys || []).forEach(function (key) {
      key = normalizeSyncKey(key);
      if (!key || storageKeySet[key]) return;
      storageKeys.push(key);
      storageKeySet[key] = true;
      changed = true;
    });

    return changed;
  }

  // Находит profile-зависимые ключи file_view в localStorage.
  function discoverAndAddLocalStorageKeys() {
    // Keep this intentionally narrow: dynamic profile file_view keys are the only
    // auto-discovered keys. Everything else should be explicit in BASE_SYNC_KEYS
    // or in the settings field.
    const found = [];

    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = String(localStorage.key(i) || '');
        if (key === 'file_view' || /^file_view_\d+$/.test(key)) found.push(key);
      }
    } catch (e) {}

    return addStorageKeys(found);
  }

  // Помечает ключи изменёнными после локального обновления.
  function markLocalKeysChanged(keys) {
    queueChangedKeys(keys, 'manual');
  }

  // Периодически сравнивает снимок localStorage и находит изменения.
  function pollLocalStorage() {
    if (!storageCtx || !storageKeys.length || applyingRemote) return;

    const changed = [];

    storageKeys.forEach(function (key) {
      const current = getRaw(key);
      const prev = lastRawSnapshot[key] || '';

      if (current !== prev) {
        lastRawSnapshot[key] = current;
        changed.push(key);
      }
    });

    if (changed.length) queueChangedKeys(changed, 'poll');
  }

  // Ставит изменённые ключи в очередь отправки на сервер.
  function queueChangedKeys(keys, reason) {
    if (!storageCtx || applyingRemote) return;

    const accepted = [];

    (keys || []).forEach(function (key) {
      key = normalizeSyncKey(key);
      if (!key) return;
      if (!storageKeySet[key]) addStorageKeys([key]);
      if (!storageKeySet[key]) return;

      if (key === 'activity' && shouldSuppressActivityPush()) {
        lastRawSnapshot[key] = getRaw(key);

        if (logEnabled()) {
          console.log('[Lampa Sync] activity change ignored during startup/apply guard');
        }

        return;
      }

      pendingKeys[key] = true;
      localChangeAt[key] = Date.now();
      lastRawSnapshot[key] = getRaw(key);
      accepted.push(key);
    });

    if (!accepted.length) return;

    schedulePushPending();

    if (logEnabled()) {
      console.log('[Lampa Sync] local changed:', accepted, reason || '');
    }
  }

  // Снимает текущее raw-состояние синхронизируемых ключей.
  function captureRawSnapshot() {
    const snap = {};
    (storageKeys || []).forEach(function (key) { snap[key] = getRaw(key); });
    return snap;
  }

  // Готовит POST payload только для изменённых ключей.
  function buildPayloadForKeys(keyList) {
    const data = {};

    keyList.forEach(function (key) {
      data[key] = getRaw(key);
    });

    return {
      data: data,
      device_id: storageCtx ? storageCtx.deviceId : getStorageDeviceId()
    };
  }

  // Откладывает отправку pending-ключей с debounce.
  function schedulePushPending() {
    if (!storageCtx || pushTimer) return;

    pushTimer = setTimeout(function () {
      pushTimer = null;
      pushPending(false);
    }, SYNC_PUSH_DEBOUNCE_MS);
  }
  async function pushPending(useBeacon) {
    if (!storageCtx || pushInFlight) return false;

    const list = Object.keys(pendingKeys).filter(function (key) { return storageKeySet[key]; });
    if (!list.length) return true;

    const payload = buildPayloadForKeys(list);
    const url = buildSyncUrl(storageCtx.userId, storageCtx.profileId);

    list.forEach(function (key) { delete pendingKeys[key]; });

    if (useBeacon && sendBeaconJson(url, payload)) {
      if (logEnabled()) console.log('[Lampa Sync] beacon queued:', list);
      return true;
    }

    pushInFlight = true;

    try {
      const resp = await httpPostJson(url, payload);
      const state = loadSyncState();
      const saved = resp && resp.saved && typeof resp.saved === 'object' ? resp.saved : {};

      Object.keys(saved).forEach(function (key) {
        const ts = Number(saved[key] || 0);
        if (isFinite(ts) && ts > 0) {
          state.keys[key] = ts;
          if (ts > state.cursor) state.cursor = ts;
        }
      });

      if (resp && Number(resp.cursor || 0) > state.cursor) {
        state.cursor = Number(resp.cursor || 0);
      }

      saveSyncState(state);

      if (logEnabled()) console.log('[Lampa Sync] pushed:', list, saved);
      return true;
    } catch (e) {
      console.error('[Lampa Sync] push error:', e);
      list.forEach(function (key) { pendingKeys[key] = true; });
      schedulePushPending();
      return false;
    } finally {
      pushInFlight = false;
    }
  }
  async function pullServerChanges(initial) {
    if (!storageCtx || serverMetaInFlight) return;

    dropSuppressedActivityPending();

    if (Object.keys(pendingKeys).length) {
      await pushPending(false);
    }

    serverMetaInFlight = true;

    try {
      const state = loadSyncState();
      const since = Math.max(0, Number(state.cursor || 0));
      const query =
        'since=' + encodeURIComponent(String(since)) +
        '&keys=' + encodeURIComponent(storageKeys.join(',')) +
        '&t=' + Date.now();
      const resp = await httpGetJson(buildSyncUrl(storageCtx.userId, storageCtx.profileId, query));

      if (!resp || resp.ok !== true) return;

      const changed = resp.changed && typeof resp.changed === 'object' ? resp.changed : {};
      const meta = resp.meta && typeof resp.meta === 'object' ? resp.meta : {};
      const origin = resp.origin_device && typeof resp.origin_device === 'object' ? resp.origin_device : {};
      const applied = [];

      Object.keys(changed).forEach(function (key) {
        key = normalizeSyncKey(key);
        if (!key || !storageKeySet[key]) return;

        const serverTs = Number(meta[key] || 0);
        const currentKnownTs = Number(state.keys[key] || 0);
        const sourceDevice = String(origin[key] || '');
        const raw = asRawString(changed[key]);

        if (serverTs > 0 && serverTs <= currentKnownTs && getRaw(key) === raw) {
          return;
        }

        if (pendingKeys[key]) {
          return;
        }

        if (sourceDevice && sourceDevice === storageCtx.deviceId && getRaw(key) === raw) {
          state.keys[key] = Math.max(currentKnownTs, serverTs);
          return;
        }

        if (key === 'activity') {
          const fp = activityFingerprint(raw);
          const token = buildActivityRemoteToken(serverTs, sourceDevice, fp);
          const fromAnotherDevice = !!sourceDevice && sourceDevice !== storageCtx.deviceId;

          if (fromAnotherDevice && token !== lastRemoteActivityAppliedToken) {
            pendingRemoteActivityPacket = {
              raw: raw,
              fp: fp,
              originDevice: sourceDevice,
              serverTs: serverTs,
              token: token
            };
            pendingRemoteActivityRaw = raw;
          }

          applyRemoteStorageValue(key, raw);
          applied.push(key);

          if (serverTs > 0) state.keys[key] = Math.max(currentKnownTs, serverTs);
          return;
        }

        if (applyRemoteStorageValue(key, raw)) {
          applied.push(key);
        }

        if (serverTs > 0) state.keys[key] = Math.max(currentKnownTs, serverTs);
      });

      const cursor = Number(resp.cursor || 0);
      if (isFinite(cursor) && cursor > state.cursor) state.cursor = cursor;

      if (initial && SYNC_BOOTSTRAP_LOCAL_AFTER_PULL && !state.bootstrapped) {
        storageKeys.forEach(function (key) {
          if (key === 'activity') return;

          if (!state.keys[key] && getRaw(key)) {
            pendingKeys[key] = true;
          }
        });
        state.bootstrapped = true;
      }

      saveSyncState(state);

      if (applied.length) {
        applyRemoteKeysToLampaRuntime(applied);
        refreshLampaUi(applied, true);
        lastRawSnapshot = captureRawSnapshot();
      }

      if (Object.keys(pendingKeys).length) schedulePushPending();

      if (logEnabled() && applied.length) {
        console.log('[Lampa Sync] remote applied:', applied, 'cursor:', state.cursor);
      }
    } catch (e) {
      if (logEnabled()) console.error('[Lampa Sync] pull error:', e);
    } finally {
      serverMetaInFlight = false;
    }
  }
  async function pullServerActivitySnapshot(reason) {
    if (!storageCtx || activitySnapshotInFlight) return false;

    activitySnapshotInFlight = true;

    try {
      const resp = await httpGetJson(buildSyncUrl(
        storageCtx.userId,
        storageCtx.profileId,
        'keys=' + encodeURIComponent('activity') + '&t=' + Date.now()
      ));

      if (!resp || resp.ok !== true) return false;

      const data = resp.data && typeof resp.data === 'object' ? resp.data : {};
      const meta = resp.meta && typeof resp.meta === 'object' ? resp.meta : {};
      const origin = resp.origin_device && typeof resp.origin_device === 'object' ? resp.origin_device : {};

      if (!Object.prototype.hasOwnProperty.call(data, 'activity')) return false;

      const raw = asRawString(data.activity);
      const serverTs = Number(meta.activity || 0);
      const sourceDevice = String(origin.activity || '');
      const hasOriginDevice = !!sourceDevice;
      const fromThisDevice = hasOriginDevice && sourceDevice === storageCtx.deviceId;
      const fromAnotherDevice = hasOriginDevice && sourceDevice !== storageCtx.deviceId;
      const localRawBefore = getRaw('activity');
      const state = loadSyncState();
      const currentKnownTs = Number(state.keys.activity || 0);

      if (serverTs > 0) {
        state.keys.activity = Math.max(currentKnownTs, serverTs);
        saveSyncState(state);
      }

      if (!raw) {
        if (logEnabled()) {
          console.log('[Lampa Sync] startup activity snapshot skipped: empty raw', {
            reason: reason || '',
            sourceDevice: sourceDevice,
            thisDevice: storageCtx.deviceId,
            serverTs: serverTs
          });
        }
        return false;
      }

      /*
       * Some older progress.php versions do not return origin_device. In that
       * case we still should apply the startup server snapshot, otherwise a new
       * device can never navigate to the already-opened screen.
       *
       * If origin_device is present and it is definitely this same device, skip
       * only when the local raw value is already identical. If localStorage has
       * a different startup page, the server snapshot is still allowed to win.
       */
      if (fromThisDevice && localRawBefore === raw) {
        if (logEnabled()) {
          console.log('[Lampa Sync] startup activity snapshot skipped: same device and same raw', {
            reason: reason || '',
            sourceDevice: sourceDevice,
            thisDevice: storageCtx.deviceId,
            serverTs: serverTs
          });
        }
        return false;
      }

      const fp = activityFingerprint(raw);
      const token = buildActivityRemoteToken(serverTs, sourceDevice || 'unknown', fp);

      if (token && token === lastRemoteActivityAppliedToken && localRawBefore === raw) {
        return false;
      }

      pendingRemoteActivityPacket = {
        raw: raw,
        fp: fp,
        originDevice: sourceDevice,
        serverTs: serverTs,
        token: token
      };
      pendingRemoteActivityRaw = raw;

      /*
       * Write server activity to localStorage, but do not push it back.
       * applyPendingRemoteActivity() is called even if localStorage already had
       * the same raw value, because the visible UI may still be on the old
       * startup screen.
       */
      applyRemoteStorageValue('activity', raw);
      applyPendingRemoteActivity(true);

      setTimeout(function () { try { applyPendingRemoteActivity(true); } catch (e) {} }, 300);
      setTimeout(function () { try { applyPendingRemoteActivity(true); } catch (e) {} }, 1200);

      if (lastRawSnapshot) {
        lastRawSnapshot.activity = getRaw('activity');
      }

      if (logEnabled()) {
        console.log('[Lampa Sync] startup activity snapshot applied:', {
          reason: reason || '',
          sourceDevice: sourceDevice,
          serverTs: serverTs,
          token: token
        });
      }

      return true;
    } catch (e) {
      if (logEnabled()) console.warn('[Lampa Sync] startup activity snapshot failed:', e);
      return false;
    } finally {
      activitySnapshotInFlight = false;
    }
  }

  // Безопасно применяет одно значение localStorage с сервера.
  function applyRemoteStorageValue(key, raw) {
    if (isBrokenArrayString(raw)) return false;

    applyingRemote = true;
    try {
      return setStorageRaw(key, raw || '');
    } finally {
      applyingRemote = false;
      if (lastRawSnapshot) lastRawSnapshot[key] = getRaw(key);
    }
  }

  // Возвращает mirror-ключи file_view для текущего профиля.
  function getFileViewMirrorKeys(primaryKey) {
    const profileId = normalizeProfileId(storageCtx && storageCtx.localProfileId || getProfileId());
    return unique([primaryKey, 'file_view', 'file_view_' + profileId].map(normalizeSyncKey).filter(Boolean));
  }

  // Фильтрует старые служебные timeline-ключи, не используемые Lampa.
  function isSyntheticTimelineHash(hash) {
    const s = String(hash || '');
    return /^url_\d+$/.test(s) ||
      /^title_\d+$/.test(s) ||
      /^id_\d+(?:_s\d+_e\d+)?$/.test(s) ||
      /^movie_\d+$/.test(s) ||
      /^card_\d+$/.test(s);
  }

  // Приводит timeline к нативному формату Lampa.
  function makeNativeTimelinePayload(item, profileId) {
    const normalized = normalizeTimelineItem(item) || {
      duration: 0,
      time: 0,
      percent: 0,
      profile: normalizeProfileId(profileId)
    };

    return {
      duration: Number(normalized.duration || 0),
      time: Number(normalized.time || 0),
      percent: Math.max(0, Math.min(100, Number(normalized.percent || 0))),
      profile: normalizeProfileId(profileId !== undefined ? profileId : normalized.profile)
    };
  }

  // Удаляет повреждённые и синтетические записи из file_view.
  function cleanupFileViewObject(obj) {
    const out = {};
    let changed = false;

    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { obj: out, changed: !!obj };
    }

    Object.keys(obj).forEach(function (hash) {
      if (!hash || isSyntheticTimelineHash(hash)) {
        changed = true;
        return;
      }

      const item = normalizeTimelineItem(obj[hash]);
      if (!item) {
        changed = true;
        return;
      }

      out[hash] = makeNativeTimelinePayload(item, item.profile);
    });

    return { obj: out, changed: changed };
  }

  // Нормализует timeline-значение для сравнения local/server.
  function normalizeTimelineItem(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

    const duration = Number(value.duration || 0);
    const time = Number(value.time || value.sec || value.position || 0);
    const percent = Number(value.percent || (duration > 0 ? Math.round(time / duration * 100) : 0));
    const profile = normalizeProfileId(value.profile);

    if (!duration && !time && !percent) return null;

    return {
      duration: duration,
      time: time,
      percent: Math.max(0, Math.min(100, percent)),
      profile: profile
    };
  }

  // Решает, свежее ли серверное значение таймлайна.
  function shouldUseServerTimeline(localItem, serverItem) {
    if (!localItem) return true;
    const lp = Number(localItem.percent || 0);
    const sp = Number(serverItem.percent || 0);
    const lt = Number(localItem.time || 0);
    const st = Number(serverItem.time || 0);
    return sp > lp || (sp === lp && st > lt + 3);
  }

  // Решает, свежее ли локальное значение таймлайна.
  function shouldUseLocalTimeline(localItem, serverItem) {
    if (!localItem || !serverItem) return false;
    const lp = Number(localItem.percent || 0);
    const sp = Number(serverItem.percent || 0);
    const lt = Number(localItem.time || 0);
    const st = Number(serverItem.time || 0);
    return lp > sp || (lp === sp && lt > st + 3);
  }

  // Отправляет pending-sync перед закрытием страницы.
  function bindFlushHandlers() {
    window.addEventListener('focus', function () {
      try { pullServerChanges(false); } catch (e) {}
    });

    window.addEventListener('online', function () {
      try { pushPending(false); pullServerChanges(false); } catch (e) {}
    });

    window.addEventListener('pageshow', function () {
      try { pullServerChanges(false); } catch (e) {}
    });

    document.addEventListener('visibilitychange', function () {
      try {
        if (document.visibilityState === 'hidden') pushPending(true);
        else pullServerChanges(false);
      } catch (e) {}
    });

    window.addEventListener('pagehide', function () {
      try { pushPending(true); } catch (e) {}
    });
  }

  // Перехватывает setItem/removeItem, чтобы быстрее ловить изменения.
  function installLocalStorageHook() {
    if (storageHookInstalled || !window.Storage || !Storage.prototype) return;
    storageHookInstalled = true;

    const nativeSetItem = Storage.prototype.setItem;
    const nativeRemoveItem = Storage.prototype.removeItem;

    Storage.prototype.setItem = function (key, value) {
      const isLocal = this === window.localStorage;
      const name = normalizeSyncKey(key);
      const before = isLocal && storageKeySet[name] ? asRawString(localStorage.getItem(name)) : null;
      const result = nativeSetItem.apply(this, arguments);

      if (isLocal && !applyingRemote && storageKeySet[name]) {
        const after = asRawString(localStorage.getItem(name));
        if (before !== after) queueChangedKeys([name], 'setItem');
      }

      return result;
    };

    Storage.prototype.removeItem = function (key) {
      const isLocal = this === window.localStorage;
      const name = normalizeSyncKey(key);
      const before = isLocal && storageKeySet[name] ? asRawString(localStorage.getItem(name)) : null;
      const result = nativeRemoveItem.apply(this, arguments);

      if (isLocal && !applyingRemote && storageKeySet[name]) {
        const after = asRawString(localStorage.getItem(name));
        if (before !== after) queueChangedKeys([name], 'removeItem');
      }

      return result;
    };
  }
  async function waitForIds() {
    const deadline = Date.now() + WAIT_IDS_MS;

    while (Date.now() < deadline) {
      const userId = getUserId();
      const profileId = getProfileId();

      if (userId && profileId !== null && profileId !== undefined) {
        return { userId: userId, profileId: profileId };
      }

      await sleep(WAIT_STEP_MS);
    }

    return null;
  }

  // Определяет user_id Lampa для области синхронизации.
  function getUserId() {
    let raw = localStorage.getItem('account_user');
    let obj = raw ? safeParse(raw) : null;

    if (obj && typeof obj === 'object') {
      const id = obj.id || obj.user_id;
      const s = digitsOnly(id);
      if (s) return s;
    }

    raw = localStorage.getItem('account');
    obj = raw ? safeParse(raw) : null;

    if (obj && typeof obj === 'object') {
      const s2 = digitsOnly(obj.id);
      if (s2) return s2;
    }

    return null;
  }

  // Определяет profile_id Lampa.
  function getProfileId() {
    const candidates = [];

    ['account_user', 'account'].forEach(function (storageKey) {
      const raw = localStorage.getItem(storageKey);
      const obj = raw ? safeParse(raw) : null;

      if (obj && typeof obj === 'object') {
        candidates.push(obj.profile && obj.profile.id);
        candidates.push(obj.profile_id);
        candidates.push(obj.active_profile_id);
      }
    });

    ['profile', 'lampa_profile'].forEach(function (storageKey) {
      const raw = localStorage.getItem(storageKey);
      const obj = raw ? safeParse(raw) : null;

      if (obj && typeof obj === 'object') {
        candidates.push(obj.profile && obj.profile.id);
        candidates.push(obj.profile_id);
        candidates.push(obj.id);
      } else {
        candidates.push(raw);
      }
    });

    try {
      if (window.Lampa && Lampa.Storage && typeof Lampa.Storage.get === 'function') {
        const p = Lampa.Storage.get('profile', null);
        if (p && typeof p === 'object') {
          candidates.push(p.id);
          candidates.push(p.profile_id);
        } else {
          candidates.push(p);
        }
      }
    } catch (e) {}

    for (let i = 0; i < candidates.length; i++) {
      const s = digitsOnly(candidates[i]);
      if (s) return s;
    }

    return '0';
  }

  // Создаёт стабильный device_id для отсечения собственных изменений.
  function getStorageDeviceId() {
    let id = '';

    try { id = localStorage.getItem(STORAGE_SYNC_DEVICE_KEY) || ''; } catch (e) {}

    if (!id) {
      id = 'ls_' + Math.random().toString(36).slice(2) + '_' + Date.now();
      try { localStorage.setItem(STORAGE_SYNC_DEVICE_KEY, id); } catch (e) {}
    }

    return id;
  }
  function isActivityLocallyBusy() {
    const changedAt = Number(localChangeAt.activity || 0);

    if (pendingKeys.activity) return true;
    if (changedAt > 0 && Date.now() - changedAt < ACTIVITY_LOCAL_GUARD_MS) return true;

    return false;
  }
  function shouldSuppressActivityPush() {
    if (!initialPullDone) return true;
    if (Date.now() < activityStartupGuardUntil) return true;
    if (Date.now() < suppressActivityPushUntil) return true;

    return false;
  }
  function dropSuppressedActivityPending() {
    if (!pendingKeys.activity) return;

    if (shouldSuppressActivityPush()) {
      delete pendingKeys.activity;

      if (lastRawSnapshot) {
        lastRawSnapshot.activity = getRaw('activity');
      }

      if (logEnabled()) {
        console.log('[Lampa Sync] startup activity push suppressed');
      }
    }
  }
  function canApplyRemoteActivity(raw) {
    if (!ACTIVITY_RUNTIME_APPLY) return false;
    if (!raw) return false;
    if (overlay || opening) return false;
    if (!window.Lampa || !Lampa.Activity) return false;
    if (isActivityLocallyBusy()) return false;
    if (Date.now() - lastActivityRuntimeAppliedAt < ACTIVITY_APPLY_COOLDOWN_MS) return false;

    return true;
  }
  function buildActivityRemoteToken(serverTs, originDevice, fp) {
    return String(serverTs || 0) + ':' + String(originDevice || '') + ':' + String(fp || '');
  }
  function activityFingerprint(raw) {
    const activity = extractActivityObject(safeParse(raw));
    if (!activity || typeof activity !== 'object') return raw ? simpleHash(String(raw)) : '';

    try { return JSON.stringify(simplifyActivity(activity, 0)); }
    catch (e) { return simpleHash(String(raw)); }
  }
  function simplifyActivity(value, depth) {
    if (depth > 4) return null;
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object') return value;

    if (Array.isArray(value)) {
      return value.slice(0, 20).map(function (item) { return simplifyActivity(item, depth + 1); });
    }

    const volatile = {
      time: true, timestamp: true, updated_at: true, updatedAt: true,
      created_at: true, createdAt: true, scroll: true, position: true,
      top: true, left: true, width: true, height: true, last: true,
      last_time: true, render: true, html: true, ready: true
    };

    const out = {};
    Object.keys(value).filter(function (key) {
      return !volatile[key] && typeof value[key] !== 'function';
    }).sort().slice(0, 60).forEach(function (key) {
      out[key] = simplifyActivity(value[key], depth + 1);
    });

    return out;
  }

  // Собирает URL progress.php с user/profile/device.
  function buildSyncUrl(userId, profileId, query) {
    const device = storageCtx && storageCtx.deviceId ? storageCtx.deviceId : getStorageDeviceId();
    const base =
      getSyncApiUrl() +
      '?user_id=' + encodeURIComponent(userId) +
      '&profile=' + encodeURIComponent(profileId) +
      '&device_id=' + encodeURIComponent(device);

    return query ? base + '&' + query : base;
  }

  // GET helper для JSON API.
  function httpGetJson(url) {
    return fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store'
    }).then(function (response) {
      return response.json().then(function (json) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        if (!json || typeof json !== 'object') throw new Error('Bad JSON');
        return json;
      });
    });
  }

  // POST helper для JSON API.
  function httpPostJson(url, bodyObj) {
    return fetch(url, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj)
    }).then(function (response) {
      return response.json().then(function (json) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        if (!json || typeof json !== 'object') throw new Error('Bad JSON');
        return json;
      });
    });
  }
  function sendBeaconJson(url, bodyObj) {
    try {
      if (!navigator.sendBeacon) return false;
      const blob = new Blob([JSON.stringify(bodyObj)], { type: 'application/json' });
      return navigator.sendBeacon(url, blob);
    } catch (e) {
      return false;
    }
  }
  function getSyncStateKey() {
    if (!storageCtx) return SYNC_CURSOR_PREFIX + 'unknown';
    return SYNC_CURSOR_PREFIX + storageCtx.userId + '_' + storageCtx.profileId;
  }
  function loadSyncState() {
    let obj = null;
    try { obj = safeParse(localStorage.getItem(getSyncStateKey()) || '{}'); } catch (e) { obj = null; }

    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
    if (!obj.keys || typeof obj.keys !== 'object' || Array.isArray(obj.keys)) obj.keys = {};

    obj.cursor = Math.max(0, Number(obj.cursor || 0));
    obj.bootstrapped = !!obj.bootstrapped;

    return obj;
  }
  function saveSyncState(state) {
    try {
      localStorage.setItem(getSyncStateKey(), JSON.stringify(state || { cursor: 0, keys: {} }));
    } catch (e) {}
  }
  function getRaw(key) {
    let value = localStorage.getItem(key);
    value = asRawString(value);
    if (isBrokenArrayString(value)) return '';
    return value;
  }
  function setRaw(key, rawValue) {
    const value = asRawString(rawValue);
    if (isBrokenArrayString(value)) return;
    setStorageRaw(key, value);
  }
  function setStorageRaw(key, rawValue) {
    const value = asRawString(rawValue);
    key = normalizeSyncKey(key) || String(key || '');

    if (!key || isBrokenArrayString(value)) return false;

    const before = localStorage.getItem(key) || '';
    if (before === value) return false;

    localStorage.setItem(key, value);
    notifyStorageChanged(key, before, value);

    if (!applyingRemote && storageKeySet[key]) {
      queueChangedKeys([key], 'setStorageRaw');
    }

    return true;
  }
  function notifyStorageChanged(key, oldValue, newValue) {
    try {
      if (window.Lampa && Lampa.Listener && typeof Lampa.Listener.send === 'function') {
        Lampa.Listener.send('storage', {
          name: key,
          key: key,
          old_value: oldValue || '',
          value: newValue || '',
          remote: !!applyingRemote
        });
      }
    } catch (e) {}

    try {
      const event = new StorageEvent('storage', {
        key: key,
        oldValue: oldValue || '',
        newValue: newValue || '',
        storageArea: localStorage,
        url: location.href
      });
      window.dispatchEvent(event);
    } catch (e) {
      try {
        const fallback = document.createEvent('Event');
        fallback.initEvent('storage', false, false);
        fallback.key = key;
        fallback.oldValue = oldValue || '';
        fallback.newValue = newValue || '';
        window.dispatchEvent(fallback);
      } catch (e2) {}
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers.
  // ---------------------------------------------------------------------------

  // Достаёт stream URL из объекта Lampa.Player.play(data).
  function getStreamUrl(data) {
    return data?.url || data?.file || data?.link || data?.stream || data?.video || null;
  }

  // Получает название из data Lampa.
  function getTitle(data) {
    return data?.title || data?.name || data?.movie?.title || data?.card?.title || data?.card?.name || 'Видео';
  }

  // Создаёт стабильный content_id для плеера и прогресса.
  function getContentId(data, streamUrl) {
    /*
     * Главное правило: прогресс привязываем к конкретному stream-файлу,
     * а не к generic data.content_id из Lampa. В некоторых экранах Lampa этот
     * id может быть одинаковым для разных фильмов/вариантов, из-за чего все
     * фильмы стартуют с одной старой позиции и новые записи отклоняются.
     */
    const preparedItem = findPreparedFastItem(streamUrl);
    const identityUrl = preparedItem && (preparedItem.source_url || preparedItem.normalized_url)
      ? (preparedItem.source_url || preparedItem.normalized_url)
      : streamUrl;

    const byStream = makeProgressContentIdFromStream(identityUrl);
    if (byStream) return byStream;

    const season = getSeasonNumber(data);
    const episode = getEpisodeNumber(data);
    const baseId = data?.movie?.id || data?.card?.id || data?.object?.id || data?.id || '';

    if (baseId && (season || episode)) return 'id_' + baseId + '_s' + (season || 0) + '_e' + (episode || 0);
    if (baseId) return 'id_' + baseId;

    return 'url_' + simpleHash(streamUrl || JSON.stringify(data || {}));
  }

  function makeProgressContentIdFromStream(streamUrl) {
    if (!streamUrl) return '';

    let raw = String(streamUrl || '');
    for (let i = 0; i < 2; i++) {
      try {
        const decoded = decodeURIComponent(raw);
        if (decoded === raw) break;
        raw = decoded;
      } catch (e) {
        break;
      }
    }

    try {
      const nested = new URL(raw, location.href).searchParams.get('url');
      if (nested && nested !== raw) {
        const nestedId = makeProgressContentIdFromStream(nested);
        if (nestedId) return nestedId;
      }
    } catch (e) {}

    const torrentKey = torrentKeyFromUrl(raw);
    const pathKey = normalizeStreamPathForMatch(raw);

    if (torrentKey || pathKey) {
      return 'stream_' + simpleHash((torrentKey || '') + '|' + (pathKey || ''));
    }

    try {
      const u = new URL(raw, location.href);
      const stable = [
        u.pathname || '',
        u.searchParams.get('link') || '',
        u.searchParams.get('index') || u.searchParams.get('id') || ''
      ].join('|');

      if (stable.replace(/\|/g, '') !== '') {
        return 'stream_' + simpleHash(stable);
      }
    } catch (e) {}

    return raw ? 'url_' + simpleHash(raw) : '';
  }

  function buildProgressAltIds(primary, originalUrl, playbackUrl, preparedItem) {
    const ids = [primary];

    [originalUrl, playbackUrl].forEach(function (url) {
      const id = makeProgressContentIdFromStream(url);
      if (id) ids.push(id);
    });

    if (preparedItem) {
      [preparedItem.source_url, preparedItem.normalized_url, preparedItem.hls_url].forEach(function (url) {
        const id = makeProgressContentIdFromStream(url);
        if (id) ids.push(id);
      });

      // prepared task id is a useful fallback, but it must never become the main progress id.
      if (preparedItem.content_id) ids.push(String(preparedItem.content_id));
    }

    return unique(ids);
  }

  function getSeasonNumber(data) {
    return firstDigits(
      data?.season || data?.season_number || data?.season_num || data?.episode?.season ||
      data?.serie?.season || data?.method?.season || data?.movie?.season
    );
  }
  function getEpisodeNumber(data) {
    return firstDigits(
      data?.episode || data?.episode_number || data?.episode_num || data?.serie?.episode ||
      data?.method?.episode || data?.movie?.episode
    );
  }
  function firstDigits() {
    for (let i = 0; i < arguments.length; i++) {
      const s = digitsOnly(arguments[i]);
      if (s) return s;
    }
    return '';
  }

  // Безопасный JSON.parse без исключения наружу.
  function safeParse(value) {
    try { return JSON.parse(value); } catch (e) { return null; }
  }
  function digitsOnly(value) {
    const s = String(value === null || value === undefined ? '' : value).replace(/[^0-9]/g, '');
    return s || null;
  }
  function isBrokenArrayString(value) {
    return typeof value === 'string' && value === 'Array';
  }

  // Приводит значение localStorage к строке для отправки на сервер.
  function asRawString(value) {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    try { return JSON.stringify(value); } catch (e) { return ''; }
  }
  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // Простой hash для fallback content_id/device_id.
  function simpleHash(str) {
    str = String(str || '');
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  start();
})();
