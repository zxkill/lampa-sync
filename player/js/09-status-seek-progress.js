/*
 * Lampa Sync Player — статус FFmpeg, перемотка, UI прогресса и сохранение.
 *
 * Здесь плеер опрашивает backend, обновляет шкалы времени/буфера,
 * сохраняет прогресс и отправляет его родительскому плагину Lampa.
 */
    async function poll() {
        applyStatus(await fetchStatus());
    }
    async function fetchStatus() {
        try {
            return await (await fetch(API + '?transcode_status=1&sid=' + encodeURIComponent(sid) + '&t=' + Date.now())).json();
        } catch (e) {
            return {ok: false, error: String(e)};
        }
    }

    // Применяет статус временной HLS-сессии или prepared-HLS к UI.
    function applyStatus(s) {
        if (!s || !s.ok) return;

        if (s.duration > 0) duration = Math.max(duration, +s.duration);

        offset = +(s.offset ?? offset);
        preparedUntil = +(s.prepared_until ?? preparedUntil);
        preparedSec = +(s.prepared_seconds ?? preparedSec);

        mode.innerText = s.encoding && s.encoding.name ? s.encoding.name : 'HLS';
        prepared.innerText = (s.segments || 0) + ' сегм. / ' + fmt(preparedSec || 0);

        if (s.encoding && s.encoding.cpu_level) quality.innerText = activeQuality + ' · CPU ' + s.encoding.cpu_level;

        ui();
    }
    async function seek(t) {
        const d = total();

        t = Math.max(0, t);

        if (d > 0) t = Math.min(d - 1, t);

        if (preparedPlaybackLoaded || (!trans && !needsProxy(src))) {
            const mediaDuration = preparedPlaybackLoaded && v.duration && isFinite(v.duration) && v.duration > 0 ? Number(v.duration) : d;
            if (mediaDuration > 0) t = Math.min(Math.max(0, t), Math.max(0, mediaDuration - 0.25));
            try { v.currentTime = t; } catch (e) {}
            setTimeout(ui, 80);
            return;
        }

        const local = t - offset;

        if (local >= 0 && local <= Math.max(0, preparedSec - 8)) {
            v.currentTime = local;
            return;
        }

        save(false);
        note('Перемотка: ' + fmt(t));
        await startHls(t, true);
    }

    // Обновляет время, прогресс, буфер и кнопки на экране.
    function ui() {
        const g = globalTime();
        const d = total();

        if (d > 0) {
            const p = Math.min(100, Math.max(0, g / d * 100));
            bar.style.width = p + '%';
            knob.style.left = p + '%';
            buf.style.width = Math.min(100, Math.max(0, preparedUntil / d * 100)) + '%';
            time.innerText = fmt(g) + ' / ' + fmt(d);
            if (iphoneReadout) iphoneReadout.innerText = fmt(g) + ' / ' + fmt(d);
            if (iphoneBar) iphoneBar.style.width = p + '%';
            if (iphoneBuf) iphoneBuf.style.width = Math.min(100, Math.max(0, preparedUntil / d * 100)) + '%';
        } else {
            time.innerText = fmt(g) + ' / --:--';
            if (iphoneReadout) iphoneReadout.innerText = fmt(g) + ' / --:--';
            if (iphoneBar) iphoneBar.style.width = '0%';
            if (iphoneBuf) iphoneBuf.style.width = '0%';
        }
    }

    // Возвращает позицию просмотра в глобальном времени фильма.
    function globalTime() {
        return (preparedPlaybackLoaded ? 0 : offset) + (v.currentTime || 0);
    }

    // Возвращает общую длительность фильма/серии.
    function total() {
        if (preparedPlaybackLoaded) {
            if (v.duration && isFinite(v.duration) && v.duration > 0) return Number(v.duration);
            if (preparedMediaDuration > 0) return preparedMediaDuration;
            if (duration > 0) return duration;
            return 0;
        }

        if (duration > 0) return duration;

        if (v.duration && isFinite(v.duration)) {
            return trans ? offset + v.duration : v.duration;
        }

        return 0;
    }

    // Сохраняет прогресс просмотра на сервер и отправляет его в Lampa.
    function save(ended, beacon = false) {
        const d = total();
        const pos = globalTime();

        if (!d || !isFinite(d)) return;

        const sec = Math.floor(pos);

        if (!ended && sec === lastSaved && !beacon) return;

        lastSaved = sec;

        const payload = {
            // Главный ключ записи прогресса. Должен быть стабильным и уникальным для фильма/серии.
            content_id: baseCid,
            progress_content_id: baseCid,
            media_content_id: mediaCid,
            progress_aliases: progressIds,
            timeline_hashes: timelineHashes,
            mirror_lampa_timeline: mirrorLampaTimeline,
            title: titleText,
            url: src,
            position: pos,
            duration: d,
            percent: d ? Math.round(pos / d * 100) : 0,
            ended: !!(ended || v.ended),
            device_id: deviceId(),
            updated_at: Date.now()
        };

        notifyLampaProgress(payload);

        if (beacon && navigator.sendBeacon) {
            navigator.sendBeacon(API, new Blob([JSON.stringify(payload)], {type: 'application/json'}));
            return;
        }

        fetch(API, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        }).catch(() => {});
    }

    // Передаёт прогресс в родительский плагин Lampa через postMessage.
    function notifyLampaProgress(payload) {
        try {
            window.parent.postMessage({
                type: 'lampa-sync-progress',
                payload: payload
            }, '*');
        } catch (e) {}
    }

    // Корректно останавливает HLS и сообщает серверу о закрытии временной сессии.
    function shutdown() {
        if (stopped) return;

        stopped = true;
        save(false, true);
        clearInterval(timer);
        clearInterval(prepareUiTimer);

        if (trans || needsProxy(src)) {
            const u = API + '?transcode_stop=1&sid=' + encodeURIComponent(sid) + '&delete=1';

            if (navigator.sendBeacon) {
                navigator.sendBeacon(u, new Blob(['{}'], {type: 'application/json'}));
            } else {
                fetch(u, {method: 'POST', keepalive: true}).catch(() => {});
            }
        }
    }
