/*
 * Lampa Sync Player — кнопка “Скачать” и связь с очередью подготовки.
 *
 * Файл отвечает только за состояние prepared-задачи в интерфейсе плеера:
 * статус, проценты, запуск, удаление готового HLS и открытие страницы очереди.
 */
    function openPrepareQueue() {
        window.open(new URL('prepare_queue.html?t=' + Date.now(), window.location.href).toString(), '_blank');
    }
    async function loadPrepareState() {
        prepareState = {status: 'idle', progress: 0, updated_at: Date.now()};
        await refreshPrepareState(false);
    }
    async function fetchPrepareStatus() {
        const u = API +
            '?prepare_status=1' +
            '&content_id=' + encodeURIComponent(mediaContentId()) +
            '&url=' + encodeURIComponent(src || '') +
            '&audio_track=' + encodeURIComponent(String(activeAudioTrack)) +
            '&t=' + Date.now();
        const r = await fetch(u, {cache: 'no-store'});
        const d = await r.json();
        if (!d || !d.ok) throw new Error((d && d.error) || 'prepare_status failed');
        return d.item || {status: 'idle', content_id: mediaContentId(), audio_track: activeAudioTrack};
    }
    async function refreshPrepareState(showErrors) {
        try {
            const item = await fetchPrepareStatus();
            prepareState = normalizePrepareItem(item);
            renderPrepareButton();
            return prepareState;
        } catch (e) {
            if (showErrors) note('Не удалось получить статус подготовки');
            renderPrepareButton();
            return prepareState || {status: 'idle', progress: 0};
        }
    }

    // Приводит запись prepare_status/list к единому формату.
    function normalizePrepareItem(item) {
        item = item && typeof item === 'object' ? item : {};
        const status = String(item.status || 'idle');
        return {
            status: status,
            progress: Math.max(0, Math.min(100, Number(item.progress || 0))),
            title: item.title || titleText,
            content_id: item.content_id || mediaContentId(),
            audio_track: Number(item.audio_track || activeAudioTrack),
            audio_tracks: Array.isArray(item.audio_tracks) ? item.audio_tracks : [],
            prepare_key: item.prepare_key || '',
            hls_url: item.hls_url || '',
            duration: Number(item.duration || 0),
            prepared_seconds: Number(item.prepared_seconds || 0),
            segments: Number(item.segments || 0),
            running: !!item.running,
            error: item.error || '',
            updated_at: Number(item.updated_at || Date.now())
        };
    }

    // Отрисовывает кнопку “Скачать/Готовится/Готово” в верхней панели.
    function renderPrepareButton() {
        if (!prepareBtn) return;

        const status = prepareState && prepareState.status ? String(prepareState.status) : 'idle';
        prepareBtn.classList.remove('preparing', 'ready', 'delete');
        prepareBtn.disabled = false;

        if (status === 'queued') {
            prepareBtn.classList.add('preparing');
            prepareBtn.innerText = '⏳ Очередь';
            prepareBtn.title = 'Видео добавлено в очередь фоновой подготовки. Плеер можно закрыть.';
            return;
        }

        if (status === 'processing') {
            const p = Math.max(0, Math.min(99, Number(prepareState.progress || 0)));
            prepareBtn.classList.add('preparing');
            prepareBtn.innerText = '⏳ ' + Math.floor(p) + '%';
            prepareBtn.title = 'Идёт фоновая подготовка. Плеер можно закрыть.';
            return;
        }

        if (status === 'ready') {
            prepareBtn.classList.add('ready');
            prepareBtn.innerText = '✓ Готово';
            prepareBtn.title = 'Видео подготовлено. При запуске будет использоваться готовый HLS. Нажмите, чтобы удалить.';
            return;
        }

        if (status === 'error') {
            prepareBtn.classList.add('delete');
            prepareBtn.innerText = '⚠ Ошибка';
            prepareBtn.title = 'Подготовка завершилась ошибкой. Нажмите, чтобы поставить задачу заново.';
            return;
        }

        prepareBtn.innerText = '⇩ Скачать';
        prepareBtn.title = 'Добавить видео в фоновую очередь подготовки';
    }

    // Периодически обновляет статус подготовки в плеере.
    function startPrepareUiTicker() {
        clearInterval(prepareUiTimer);
        prepareUiTimer = setInterval(async function () {
            await refreshPrepareState(false);
        }, 3000);
    }
    async function togglePrepare() {
        await refreshPrepareState(false);
        const status = prepareState.status || 'idle';

        if (status === 'ready') {
            try {
                const u = API + '?prepare_delete=1&content_id=' + encodeURIComponent(mediaContentId()) + '&t=' + Date.now();
                const d = await (await fetch(u, {cache: 'no-store'})).json();
                if (!d.ok) throw new Error(d.error || 'delete failed');
                prepareState = {status: 'idle', progress: 0, updated_at: Date.now()};
                renderPrepareButton();
                note('Подготовленный HLS удалён');
            } catch (e) {
                note('Не удалось удалить подготовленный HLS');
            }
            return;
        }

        if (status === 'queued' || status === 'processing') {
            note('Подготовка уже идёт. Плеер можно закрыть.');
            renderPrepareButton();
            return;
        }

        try {
            prepareBtn.disabled = true;
            prepareBtn.innerText = '⏳ Старт...';
            const u = API +
                '?prepare_start=1' +
                '&url=' + encodeURIComponent(src) +
                '&content_id=' + encodeURIComponent(mediaContentId()) +
                '&title=' + encodeURIComponent(titleText) +
                '&quality=' + encodeURIComponent(activeQuality) +
                '&audio_track=' + encodeURIComponent(String(activeAudioTrack)) +
                '&t=' + Date.now();
            const d = await (await fetch(u, {cache: 'no-store'})).json();
            if (!d.ok) throw new Error(d.error || 'prepare_start failed');
            prepareState = normalizePrepareItem(d.item || {status: 'queued'});
            renderPrepareButton();
            note('Добавлено в очередь. Плеер можно закрыть.');
        } catch (e) {
            prepareState = {status: 'error', error: e.message || 'prepare_start failed', progress: 0};
            renderPrepareButton();
            note('Не удалось добавить в очередь');
        }
    }

    // Для prepared-HLS корректирует duration/offset после загрузки metadata.
    function installPreparedMetadataFix() {
        let applied = false;

        const apply = function () {
            const mediaDuration = (v.duration && isFinite(v.duration) && v.duration > 0) ? Number(v.duration) : 0;

            if (mediaDuration > 0) {
                preparedMediaDuration = mediaDuration;
                duration = mediaDuration;
                preparedSec = mediaDuration;
                preparedUntil = mediaDuration;
                prepared.innerText = 'готово / ' + fmt(mediaDuration);
            }

            if (!applied) {
                applied = true;
                let t = Math.max(0, Number(preparedResumePending || 0));
                const d = mediaDuration || duration || 0;

                if (d > 0) t = Math.min(t, Math.max(0, d - 1));

                if (t > 0) {
                    try { v.currentTime = t; } catch (e) {}
                }
            }

            setTimeout(ui, 80);
        };

        v.addEventListener('loadedmetadata', apply, { once: false });
        v.addEventListener('durationchange', apply, { once: false });
        v.addEventListener('canplay', apply, { once: false });
        setTimeout(apply, 400);
        setTimeout(apply, 1400);
    }
