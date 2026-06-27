/*
 * Lampa Sync Player — состояние и ссылки на DOM.
 *
 * Здесь находятся query-параметры, стабильные идентификаторы прогресса,
 * настройки аудио/субтитров, ссылки на элементы интерфейса и runtime-переменные.
 */
const API = new URL('api.php', window.location.href).toString();

    const qs = new URLSearchParams(location.search);
    const src = qs.get('url');
    const titleText = qs.get('title') || 'Видео';

    /*
     * Важное разделение идентификаторов:
     * - mediaCid: конкретный вариант запуска (prepared-HLS, аудиодорожка и т.п.);
     * - progressCid: стабильный ключ прогресса именно этого фильма/серии.
     *
     * Если сохранять прогресс под generic id из Lampa или под id prepared-задачи,
     * разные фильмы могут читать одну и ту же старую позицию, а новые записи будут
     * отбрасываться как “откат назад”. Поэтому read/write всегда идут по baseCid.
     */
    const mediaCid = qs.get('content_id') || hash(src || titleText);
    const progressCid = qs.get('progress_content_id') || mediaCid;
    const cid = mediaCid;
    const baseCid = String(progressCid || mediaCid).replace(/_a\d+$/, '');
    const progressAltIds = (qs.get('progress_alt_ids') || '')
        .split(',')
        .map(v => String(v || '').trim())
        .filter(Boolean);
    const progressIds = uniqueProgressIds([
        baseCid,
        progressCid,
        String(progressCid || '').replace(/_a\d+$/, ''),
        mediaCid,
        String(mediaCid || '').replace(/_a\d+$/, '')
    ].concat(progressAltIds));
    const timelineHashes = uniqueProgressIds((qs.get('timeline_hashes') || '')
        .split(',')
        .map(v => String(v || '').trim())
        .filter(Boolean));
    const mirrorLampaTimeline = qs.get('mirror_lampa_timeline') === '1' || qs.get('from_queue') === '1';
    const trans = qs.get('transcode') === '1' || qs.get('hls') === '1';
    const q = qs.get('quality') || 'fast';
    let activeQuality = q;

    // Субтитры временно отключены: UI и загрузка WebVTT не запускаются.
    // Логика оставлена в файле, чтобы позже можно было вернуться без отката больших блоков.
    const SUBTITLES_ENABLED = false;
    const audioPrefKey = 'lampa_sync_audio_track_' + hash(src || baseCid);
    const explicitAudioTrack = qs.has('audio_track') || localStorage.getItem(audioPrefKey) !== null;
    let activeAudioTrack = Math.max(0, parseInt(qs.get('audio_track') || localStorage.getItem(audioPrefKey) || '0', 10) || 0);
    let audioTracks = [];
    let audioTracksLoaded = false;

    const subtitlePrefKey = 'lampa_sync_subtitle_track_' + hash(src || baseCid);
    const explicitSubtitleTrack = qs.has('subtitle_track') || localStorage.getItem(subtitlePrefKey) !== null;
    let activeSubtitleTrack = parseInt(qs.get('subtitle_track') || localStorage.getItem(subtitlePrefKey) || '-1', 10);
    if (!isFinite(activeSubtitleTrack)) activeSubtitleTrack = -1;
    let subtitleTracks = [];
    let currentSubtitleEl = null;
    let subtitleCues = [];
    let subtitleOverlayText = '';
    let subtitleClockMode = 'local'; // local = video.currentTime, global = offset + currentTime

    const app = document.getElementById('app');
    const v = document.getElementById('video');
    const title = document.getElementById('title');
    const mode = document.getElementById('mode');
    const quality = document.getElementById('quality');
    const audioSelect = document.getElementById('audioTrack');
    const subtitleSelect = document.getElementById('subtitleTrack');
    const subtitleOverlay = document.getElementById('subtitleOverlay');
    let subtitleLoadToken = 0;
    const prepared = document.getElementById('prepared');
    const prepareBtn = document.getElementById('prepareBtn');
    const queueBtn = document.getElementById('queueBtn');
    const statusBox = document.getElementById('status');
    const statusText = document.getElementById('statusText');
    const center = document.getElementById('center');
    const play = document.getElementById('play');
    const back = document.getElementById('back');
    const fwd = document.getElementById('fwd');
    const closeBtn = document.getElementById('close');
    const full = document.getElementById('full');
    const fit = document.getElementById('fit');
    const progWrap = document.getElementById('progWrap');
    const prog = document.getElementById('prog');
    const bar = document.getElementById('bar');
    const buf = document.getElementById('buf');
    const knob = document.getElementById('knob');
    const row = document.getElementById('row');
    const time = document.getElementById('time');
    const vol = document.getElementById('vol');
    const err = document.getElementById('err');
    const toast = document.getElementById('toast');
    const iphonePanel = document.getElementById('iphonePanel');
    const iphoneHud = document.getElementById('iphoneHud');
    const iphoneReadout = document.getElementById('iphoneReadout');
    const iphoneBar = document.getElementById('iphoneBar');
    const iphoneBuf = document.getElementById('iphoneBuf');
    const ipPlay = document.getElementById('ipPlay');
    const ipBack = document.getElementById('ipBack');
    const ipFwd = document.getElementById('ipFwd');
    const ipFit = document.getElementById('ipFit');
    const ipFull = document.getElementById('ipFull');

    let hls = null;
    let sid = makeSid();
    let offset = 0;
    let duration = 0;
    let preparedUntil = 0;
    let preparedSec = 0;
    let saved = null;
    let lastSync = 0;
    let lastSaved = -1;
    let timer = null;
    let hideTimer = null;
    let lastBackgroundToggleAt = 0;
    let lastBackgroundTouchAt = 0;
    let controlsHiddenByTap = false;
    let suppressAutoShowUntil = 0;
    let stopped = false;
    let fitMode = 'contain';
    let lastRoutedAt = 0;
    let lastRoutedAction = '';
    let remoteFocusIndex = 0;
    let remoteModeTimer = null;
    let hlsMediaRecoveries = 0;
    let hlsSafeFallbackUsed = false;
    const prepareStateKey = 'lampa_sync_prepare_ui_' + baseCid;
    let prepareState = null;
    let prepareUiTimer = null;
    let preparedPlaybackLoaded = false;
    let preparedMediaDuration = 0;
    let preparedResumePending = 0;

    // Автовосстановление после кратких сбоев декодера/буфера.
    // Особенно полезно для быстрых TS/copy-HLS потоков на iOS/TV, где native player
    // иногда отдаёт MEDIA_ERR_DECODE, хотя следующие сегменты уже готовы.
    let lastGoodGlobalTime = 0;
    let lastGoodAt = 0;
    let playbackRecovering = false;
    let playbackRecoveryCount = 0;
    let lastPlaybackRecoveryAt = 0;
    let lastHlsUrl = '';
