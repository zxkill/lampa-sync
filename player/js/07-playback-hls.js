/*
 * Lampa Sync Player — Direct/HLS запуск и hls.js.
 *
 * Здесь остаётся запуск временного FFmpeg-HLS, открытие prepared-HLS,
 * подключение hls.js/native HLS и обработка HLS-ошибок.
 */
    async function direct(url, resume) {
        mode.innerText = 'Direct';
        mode.className = 'pill ok';
        hideStatus();
        v.src = url;
        v.onloadedmetadata = () => {
            if (v.duration && isFinite(v.duration)) duration = v.duration;
            if (resume > 0) v.currentTime = resume;
            ui();
        };
        await applySubtitleTrack();
        tryPlay();
    }
    async function startHls(start, force) {
        sid = makeSid();
        const requestedStart = Math.max(0, start || 0);

        offset = requestedStart;
        preparedUntil = offset;
        preparedSec = 0;

        const readyPrepared = await refreshPrepareState(false);
        if (readyPrepared && readyPrepared.status === 'ready' && readyPrepared.hls_url) {
            /*
             * Важное отличие prepared-HLS от временного HLS/FFmpeg:
             * prepared-HLS — это полный файл с нулевой временной шкалой.
             * Поэтому offset должен быть 0, а requestedStart надо применять
             * только как video.currentTime. Иначе время удваивается:
             * globalTime = offset + currentTime.
             */
            /*
             * Для prepared-HLS нельзя доверять duration из БД как единственному
             * источнику. В старых/ручных задачах он мог быть взят из исходного
             * контейнера или соседнего файла и отличаться от фактической длины
             * готового HLS. Поэтому сначала берём длительность плейлиста
             * prepared_seconds, а после loadedmetadata переходим на v.duration.
             */
            const playlistDuration = Math.max(0, Number(readyPrepared.prepared_seconds || 0));
            const dbDuration = Math.max(0, Number(readyPrepared.duration || 0));
            const initialPreparedDuration = playlistDuration || dbDuration || duration || 0;
            const resumeAt = initialPreparedDuration > 0
                ? Math.min(Math.max(0, requestedStart), Math.max(0, initialPreparedDuration - 1))
                : Math.max(0, requestedStart);

            offset = 0;
            preparedMediaDuration = 0;
            preparedResumePending = resumeAt;
            duration = initialPreparedDuration || 0;
            preparedSec = initialPreparedDuration || 0;
            preparedUntil = initialPreparedDuration || 0;
            preparedPlaybackLoaded = true;

            showStatus('Открываю подготовленный HLS...');
            mode.innerText = 'Prepared HLS';
            mode.className = 'pill ok';
            prepared.innerText = 'готово' + (duration > 0 ? ' / ' + fmt(duration) : '');

            destroyHls();
            await loadHls(readyPrepared.hls_url + '&t=' + Date.now());
            installPreparedMetadataFix();
            await applySubtitleTrack();
            hideStatus();

            ui();
            return;
        }

        preparedPlaybackLoaded = false;
        preparedMediaDuration = 0;
        preparedResumePending = 0;
        showStatus('FFmpeg стартует с ' + fmt(offset) + '...');
        mode.innerText = 'HLS/FFmpeg';
        mode.className = 'pill warn';

        destroyHls();

        const u = API +
            '?transcode_start=1' +
            '&url=' + encodeURIComponent(src) +
            '&content_id=' + encodeURIComponent(mediaContentId()) +
            '&sid=' + encodeURIComponent(sid) +
            '&start=' + encodeURIComponent(String(offset)) +
            '&quality=' + encodeURIComponent(activeQuality) +
            '&audio_track=' + encodeURIComponent(String(activeAudioTrack)) +
            '&force=' + (force ? '1' : '0') +
            '&t=' + Date.now();

        const d = await (await fetch(u)).json();

        if (!d.ok) {
            showError(d.error || 'Не удалось запустить FFmpeg');
            return;
        }

        applyStatus(d);

        clearInterval(timer);
        timer = setInterval(poll, 1500);

        for (let i = 0; i < 80; i++) {
            const s = await fetchStatus();
            applyStatus(s);

            if (s.ready && s.hls_url) {
                await loadHls(s.hls_url);
                await applySubtitleTrack();
                hideStatus();
                return;
            }

            if (!s.running && !s.ready && i > 6) {
                showError('FFmpeg остановился. Лог: ' + esc(s.last_log || ''));
                return;
            }

            showStatus('Подготовка HLS: сегментов ' + (s.segments || 0) + ', готово ' + fmt(s.prepared_seconds || 0));
            await sleep(1200);
        }

        showError('HLS слишком долго не готовится');
    }
    async function loadHls(url) {
        destroyHls();
        hlsMediaRecoveries = 0;
        lastHlsUrl = String(url || '');

        if (window.Hls && Hls.isSupported()) {
            hls = new Hls({
                lowLatencyMode: false,
                backBufferLength: 30,
                maxBufferLength: 60,
                manifestLoadingTimeOut: 20000,
                fragLoadingTimeOut: 30000
            });

            hls.loadSource(url);
            hls.attachMedia(v);

            hls.on(Hls.Events.ERROR, (e, d) => {
                console.warn('HLS', d);
                handleHlsError(d);
            });

            hls.on(Hls.Events.MANIFEST_PARSED, tryPlay);
        } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
            v.src = url;
            tryPlay();
        } else {
            showError('HLS не поддерживается, hls.js не загрузился');
        }
    }
    async function handleHlsError(d) {
        if (!d) return;

        const details = String(d.details || '');
        const type = String(d.type || '');

        if (type === 'mediaError' && hls && hlsMediaRecoveries < 2) {
            hlsMediaRecoveries++;

            try {
                note('Восстанавливаю HLS-буфер...');
                hls.recoverMediaError();
                return;
            } catch (e) {}
        }

        if (details === 'bufferAppendError' && !hlsSafeFallbackUsed) {
            hlsSafeFallbackUsed = true;
            activeQuality = 'safe';
            quality.innerText = activeQuality;

            showStatus('Плеер не принял поток. Перезапускаю в совместимом H.264/AAC режиме...');

            try {
                await startHls(Math.max(0, globalTime() - 2), true);
                return;
            } catch (e) {
                console.warn('Safe HLS fallback failed', e);
            }
        }

        if (d.fatal) {
            showError('Ошибка HLS: ' + esc(type) + ' / ' + esc(details));
        }
    }
