/*
 * Lampa Sync Player — аудиодорожки и заготовка субтитров.
 *
 * Субтитры сейчас отключены флагом SUBTITLES_ENABLED, но код оставлен
 * для будущего включения без большого отката.
 */
    // Загружает список аудиодорожек через ffprobe endpoint до запуска HLS.
    async function loadAudioTracks() {
        if (!src || audioTracksLoaded) return audioTracks;
        audioTracksLoaded = true;

        try {
            const u = API + '?media_info=1&url=' + encodeURIComponent(src) + '&t=' + Date.now();
            const d = await (await fetch(u, {cache: 'no-store'})).json();
            audioTracks = d && d.ok && Array.isArray(d.audio_tracks) ? d.audio_tracks : [];
            subtitleTracks = d && d.ok && Array.isArray(d.subtitle_tracks) ? d.subtitle_tracks : [];

            if (!explicitAudioTrack && audioTracks.length) {
                const preferred = findPreferredAudioTrack(audioTracks);
                if (preferred >= 0) activeAudioTrack = preferred;
            }

            if (!explicitSubtitleTrack) {
                activeSubtitleTrack = -1;
            }

            renderAudioTrackSelect();
            renderSubtitleTrackSelect();
        } catch (e) {
            audioTracks = [];
            subtitleTracks = [];
            renderAudioTrackSelect();
            renderSubtitleTrackSelect();
        }

        return audioTracks;
    }

    // По умолчанию стараемся выбрать русскую дорожку, если она явно подписана как ru/rus/russian/рус.
    function findPreferredAudioTrack(tracks) {
        for (const track of tracks) {
            const text = [track.language, track.title, track.label].join(' ').toLowerCase();
            if (/\b(rus|ru|russian)\b/.test(text) || text.indexOf('рус') >= 0) {
                return Number(track.audio_index || 0);
            }
        }
        const def = tracks.find(track => !!track.default);
        return def ? Number(def.audio_index || 0) : Number(tracks[0].audio_index || 0);
    }

    // Рисует выпадающий список аудиодорожек в верхней панели.
    function renderAudioTrackSelect() {
        if (!audioSelect) return;

        audioSelect.innerHTML = '';
        if (!audioTracks.length) {
            audioSelect.classList.add('hide');
            return;
        }

        audioTracks.forEach(track => {
            const option = document.createElement('option');
            option.value = String(track.audio_index || 0);
            option.textContent = track.label || ('Аудио ' + (Number(track.audio_index || 0) + 1));
            audioSelect.appendChild(option);
        });

        audioSelect.value = String(activeAudioTrack);
        audioSelect.classList.remove('hide');
    }

    // Рисует выпадающий список субтитров. Первый пункт всегда выключает субтитры.
    function renderSubtitleTrackSelect() {
        if (!subtitleSelect) return;
        if (!SUBTITLES_ENABLED) {
            activeSubtitleTrack = -1;
            subtitleTracks = [];
            try { subtitleSelect.value = '-1'; } catch (e) {}
            subtitleSelect.classList.add('hide');
            clearSubtitleTrack();
            return;
        }

        subtitleSelect.innerHTML = '';

        const off = document.createElement('option');
        off.value = '-1';
        off.textContent = 'Субтитры: выкл.';
        subtitleSelect.appendChild(off);

        const usable = subtitleTracks.filter(track => track && track.supported !== false);
        if (!usable.length) {
            subtitleSelect.classList.add('hide');
            return;
        }

        usable.forEach(track => {
            const option = document.createElement('option');
            option.value = String(track.subtitle_index || 0);
            option.textContent = track.label || ('Субтитры ' + (Number(track.subtitle_index || 0) + 1));
            subtitleSelect.appendChild(option);
        });

        subtitleSelect.value = String(activeSubtitleTrack);
        subtitleSelect.classList.remove('hide');
    }

    // Удаляет текущие субтитры: и нативный <track>, и наш JS-overlay.
    function clearSubtitleTrack() {
        if (currentSubtitleEl && currentSubtitleEl.parentNode) {
            currentSubtitleEl.parentNode.removeChild(currentSubtitleEl);
        }
        currentSubtitleEl = null;
        subtitleCues = [];
        subtitleOverlayText = '';
        subtitleClockMode = 'local';
        updateSubtitleOverlay(true);
    }

    // Загружает выбранную дорожку субтитров как WebVTT.
    // Backend теперь может готовить VTT в фоне: если он возвращает 202/pending,
    // плеер не падает с ошибкой, а аккуратно ждёт готовый файл и опрашивает endpoint.
    async function applySubtitleTrack() {
        clearSubtitleTrack();

        if (!SUBTITLES_ENABLED) return;
        if (activeSubtitleTrack < 0 || !src) return;

        const token = ++subtitleLoadToken;
        const subtitleOffset = preparedPlaybackLoaded ? 0 : Math.max(0, offset || 0);
        const url = API +
            '?subtitle_vtt=1' +
            '&url=' + encodeURIComponent(src) +
            '&subtitle_track=' + encodeURIComponent(String(activeSubtitleTrack)) +
            '&start=' + encodeURIComponent(String(subtitleOffset));

        try {
            note('Субтитры готовятся...');
            const text = await waitSubtitleVtt(url, token);
            if (token !== subtitleLoadToken || activeSubtitleTrack < 0) return;

            subtitleCues = parseWebVtt(text);
            subtitleClockMode = chooseSubtitleClockMode(subtitleCues, subtitleOffset);

            if (!subtitleCues.length) {
                console.warn('[Lampa Sync] subtitle vtt has no cues:', text.slice(0, 500));
                note('Субтитры пустые или не распознаны');
                return;
            }

            // Нативный track оставляем как дополнительный fallback для браузеров, где он работает.
            const tr = document.createElement('track');
            tr.kind = 'subtitles';
            tr.label = subtitleSelect && subtitleSelect.selectedIndex >= 0
                ? subtitleSelect.options[subtitleSelect.selectedIndex].textContent
                : 'Субтитры';
            tr.srclang = subtitleLanguage(activeSubtitleTrack) || 'ru';
            tr.src = url + '&t=' + Date.now();
            tr.default = true;
            v.appendChild(tr);
            currentSubtitleEl = tr;

            tr.addEventListener('load', () => {
                try {
                    for (let i = 0; i < v.textTracks.length; i++) v.textTracks[i].mode = 'disabled';
                    if (tr.track) tr.track.mode = 'showing';
                } catch (e) {}
            });

            setTimeout(() => {
                try {
                    for (let i = 0; i < v.textTracks.length; i++) v.textTracks[i].mode = 'disabled';
                    if (tr.track) tr.track.mode = 'showing';
                } catch (e) {}
                updateSubtitleOverlay(true);
            }, 150);

            note('Субтитры включены');
        } catch (e) {
            if (token !== subtitleLoadToken) return;
            console.warn('[Lampa Sync] subtitle apply failed:', e);
            note(String(e && e.message ? e.message : 'Ошибка загрузки субтитров'));
        }
    }

    async function waitSubtitleVtt(baseUrl, token) {
        const maxAttempts = 300; // до 10 минут: субтитры извлекаются полным проходом от начала файла
        let lastError = '';

        for (let i = 0; i < maxAttempts; i++) {
            if (token !== subtitleLoadToken) throw new Error('Загрузка субтитров отменена');

            const response = await fetch(baseUrl + '&t=' + Date.now(), {cache: 'no-store'});
            const contentType = String(response.headers.get('content-type') || '').toLowerCase();
            const text = await response.text();

            if (response.ok && text.indexOf('-->') >= 0) {
                return text;
            }

            let json = null;
            if (contentType.indexOf('application/json') >= 0 || /^\s*\{/.test(text)) {
                try { json = JSON.parse(text); } catch (e) { json = null; }
            }

            if (response.status === 202 || (json && json.pending)) {
                if (i === 0) note('Субтитры извлекаются из файла. Это может занять несколько минут...');
                await sleep(2000);
                continue;
            }

            lastError = json && json.error ? json.error : (text ? text.slice(0, 260) : ('HTTP ' + response.status));
            break;
        }

        throw new Error(lastError ? ('Субтитры не загрузились: ' + lastError) : 'Субтитры не успели подготовиться');
    }

    // Подписки для собственной отрисовки субтитров поверх видео.
    function bindSubtitleOverlayEvents() {
        v.addEventListener('timeupdate', () => updateSubtitleOverlay(false));
        v.addEventListener('seeking', () => updateSubtitleOverlay(true));
        v.addEventListener('seeked', () => updateSubtitleOverlay(true));
        v.addEventListener('play', () => updateSubtitleOverlay(true));
        v.addEventListener('pause', () => updateSubtitleOverlay(true));
    }

    // Показывает активный cue на текущем времени video.currentTime.
    function updateSubtitleOverlay(force) {
        if (!subtitleOverlay) return;

        if (!subtitleCues.length || activeSubtitleTrack < 0) {
            subtitleOverlay.style.display = 'none';
            subtitleOverlay.textContent = '';
            subtitleOverlayText = '';
            return;
        }

        const t = subtitleCurrentTime();
        let text = '';

        for (const cue of subtitleCues) {
            if (t >= cue.start && t <= cue.end) {
                text = cue.text;
                break;
            }
        }

        if (force || text !== subtitleOverlayText) {
            subtitleOverlayText = text;
            subtitleOverlay.textContent = text;
            subtitleOverlay.style.display = text ? 'block' : 'none';
        }
    }

    // Очень простой WebVTT parser: нам нужны только start/end/text.
    function parseWebVtt(raw) {
        raw = String(raw || '').replace(/^\uFEFF/, '').replace(/\r/g, '');
        const blocks = raw.split(/\n\s*\n/g);
        const cues = [];

        for (const block of blocks) {
            const lines = block.split('\n').map(x => x.trimEnd()).filter(Boolean);
            if (!lines.length) continue;
            if (/^WEBVTT/i.test(lines[0]) || /^NOTE\b/i.test(lines[0])) continue;

            let timeLineIndex = lines.findIndex(line => line.indexOf('-->') >= 0);
            if (timeLineIndex < 0) continue;

            const m = lines[timeLineIndex].match(/([^\s]+)\s*-->\s*([^\s]+)/);
            if (!m) continue;

            let start = parseVttTime(m[1]);
            let end = parseVttTime(m[2]);
            if (!isFinite(start) || !isFinite(end) || end <= start) continue;

            const text = lines.slice(timeLineIndex + 1)
                .join('\n')
                .replace(/<[^>]+>/g, '')
                .replace(/\\N/g, '\n')
                .trim();

            if (!text) continue;

            cues.push({start, end, text});
        }

        cues.sort((a, b) => a.start - b.start);
        return cues;
    }

    // Выбирает, по каким часам сверять субтитры.
    // Временный HLS может начинаться с currentTime=0 при offset=40:00, а WebVTT
    // может прийти либо с локальными таймкодами, либо с абсолютными таймкодами фильма.
    function chooseSubtitleClockMode(cues, subtitleOffset) {
        if (!Array.isArray(cues) || !cues.length) return 'local';

        const localT = Math.max(0, Number(v.currentTime || 0));
        const globalT = Math.max(0, Number(globalTime ? globalTime() : localT));

        function distanceToNearest(t) {
            let best = Infinity;
            for (const cue of cues) {
                if (t >= cue.start && t <= cue.end) return 0;
                best = Math.min(best, Math.abs(cue.start - t), Math.abs(cue.end - t));
            }
            return best;
        }

        const dl = distanceToNearest(localT);
        const dg = distanceToNearest(globalT);

        if (subtitleOffset > 0 && dg + 5 < dl) return 'global';
        if (subtitleOffset > 0 && cues[0].start > Math.max(30, subtitleOffset * 0.5)) return 'global';
        return 'local';
    }

    function subtitleCurrentTime() {
        if (subtitleClockMode === 'global') {
            return Math.max(0, Number(globalTime ? globalTime() : 0));
        }
        return Math.max(0, Number(v.currentTime || 0));
    }

    function parseVttTime(value) {
        const parts = String(value || '').replace(',', '.').split(':');
        let h = 0, m = 0, s = 0;

        if (parts.length === 3) {
            h = Number(parts[0]);
            m = Number(parts[1]);
            s = Number(parts[2]);
        } else if (parts.length === 2) {
            m = Number(parts[0]);
            s = Number(parts[1]);
        } else {
            s = Number(parts[0]);
        }

        return h * 3600 + m * 60 + s;
    }

    function subtitleLanguage(subtitleIndex) {
        const track = subtitleTracks.find(t => Number(t.subtitle_index || 0) === Number(subtitleIndex));
        return track && track.language ? String(track.language).slice(0, 8) : '';
    }

    // При смене субтитров видео не пересобирается: меняется только подключённый WebVTT.
    function bindSubtitleTrackSelect() {
        if (!subtitleSelect) return;
        if (!SUBTITLES_ENABLED) {
            subtitleSelect.classList.add('hide');
            return;
        }
        subtitleSelect.addEventListener('change', async e => {
            const next = parseInt(e.target.value || '-1', 10);
            activeSubtitleTrack = isFinite(next) ? next : -1;
            localStorage.setItem(subtitlePrefKey, String(activeSubtitleTrack));
            note(activeSubtitleTrack < 0 ? 'Субтитры выключены' : 'Субтитры: ' + (subtitleSelect.options[subtitleSelect.selectedIndex]?.textContent || ('#' + (activeSubtitleTrack + 1))));
            await applySubtitleTrack();
        });
    }

    // При смене дорожки пересобираем HLS с той же позиции, но уже с другим -map 0:a:N.
    function bindAudioTrackSelect() {
        if (!audioSelect) return;
        audioSelect.addEventListener('change', async e => {
            const next = Math.max(0, parseInt(e.target.value || '0', 10) || 0);
            if (next === activeAudioTrack) return;

            const pos = globalTime();
            activeAudioTrack = next;
            localStorage.setItem(audioPrefKey, String(activeAudioTrack));
            sid = makeSid();
            hlsSafeFallbackUsed = false;
            prepareState = {status: 'idle', progress: 0, updated_at: Date.now()};
            renderPrepareButton();
            note('Аудиодорожка: ' + (audioSelect.options[audioSelect.selectedIndex]?.textContent || ('#' + (activeAudioTrack + 1))));

            await refreshPrepareState(false);
            if (trans || needsProxy(src)) await startHls(pos, true);
        });
    }
