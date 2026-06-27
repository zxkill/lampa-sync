/*
 * Lampa Sync Player — восстановление после сбоев воспроизведения.
 *
 * Блок запоминает последнюю хорошую позицию, перезапускает HLS с неё
 * и освобождает hls.js/видео-ресурсы при рестарте или закрытии.
 */
    // Запоминает последнюю стабильную позицию, чтобы аварийный рестарт не начинал фильм заново.
    function markGoodPlaybackPosition() {
        const g = globalTime();

        if (!isFinite(g) || g <= 0) return;
        if (v.seeking) return;

        lastGoodGlobalTime = Math.max(lastGoodGlobalTime, g);
        lastGoodAt = Date.now();
    }

    // Возвращает позицию, с которой безопаснее восстанавливать поток.
    function recoveryPosition() {
        const g = globalTime();
        const candidates = [];

        if (isFinite(g) && g > 0) candidates.push(g);
        if (isFinite(lastGoodGlobalTime) && lastGoodGlobalTime > 0) candidates.push(lastGoodGlobalTime);
        if (saved && saved.position > 0) candidates.push(Number(saved.position));

        let pos = candidates.length ? Math.max.apply(null, candidates) : 0;
        const d = total();

        if (d > 0) pos = Math.min(pos, Math.max(0, d - 1));

        return Math.max(0, pos);
    }

    // Обрабатывает ошибку native video element. Не показываем красную ошибку сразу:
    // сначала пытаемся пересобрать/перезагрузить HLS с текущего места.
    function handleVideoPlaybackError(code) {
        const errCode = String(code || '?');
        console.warn('[Lampa Sync] video error', errCode, v.error);

        recoverPlayback('код ' + errCode).catch(e => {
            console.warn('[Lampa Sync] playback recovery failed', e);
            showError('Видео не удалось воспроизвести. Код: ' + esc(errCode));
        });
    }

    // Перезапускает воспроизведение с текущего места после ошибки декодера/потока.
    async function recoverPlayback(reason) {
        if (playbackRecovering || stopped) return;

        const now = Date.now();

        // Если ошибки идут серией, считаем это одной аварией, но ограничиваем бесконечный цикл.
        if (now - lastPlaybackRecoveryAt > 60000) {
            playbackRecoveryCount = 0;
        }

        playbackRecoveryCount++;
        lastPlaybackRecoveryAt = now;

        if (playbackRecoveryCount > 6) {
            throw new Error('too many recovery attempts');
        }

        playbackRecovering = true;

        const base = recoveryPosition();
        // Первые попытки стартуют почти с той же позиции. Если тот же сегмент битый/плохо декодируется,
        // следующие попытки слегка перескакивают вперёд, чтобы не зациклиться на одном TS/fMP4-фрагменте.
        const resume = Math.max(0, base + (playbackRecoveryCount >= 3 ? 2 : 0));

        try {
            err.style.display = 'none';
            save(false);
            showStatus('Поток прервался, восстанавливаю с ' + fmt(resume) + '...');
            note('Восстанавливаю воспроизведение...');

            // Для hls.js сначала пробуем штатное восстановление media error без пересборки потока.
            if (hls && playbackRecoveryCount <= 2) {
                try {
                    hls.recoverMediaError();
                    await sleep(900);
                    if (!v.error) {
                        await tryPlay();
                        hideStatus();
                        playbackRecovering = false;
                        return;
                    }
                } catch (e) {}
            }

            if (preparedPlaybackLoaded && lastHlsUrl) {
                offset = 0;
                preparedResumePending = resume;
                await loadHls(cacheBustUrl(lastHlsUrl));
                installPreparedMetadataFix();
                await applySubtitleTrack();
                await tryPlay();
                hideStatus();
                return;
            }

            if (trans || needsProxy(src)) {
                await startHls(resume, true);
                await tryPlay();
                hideStatus();
                return;
            }

            await direct(src, resume);
            await tryPlay();
            hideStatus();
        } finally {
            playbackRecovering = false;
            setTimeout(ui, 120);
        }
    }

    function cacheBustUrl(url) {
        const clean = String(url || '').replace(/([?&])t=\d+(&?)/, function (m, p1, p2) {
            return p2 ? p1 : '';
        }).replace(/[?&]$/, '');

        return clean + (clean.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
    }

    // Останавливает hls.js и освобождает ресурсы.
    function destroyHls() {
        if (hls) {
            try { hls.destroy(); } catch (e) {}
            hls = null;
        }

        try {
            v.removeAttribute('src');
            v.load();
        } catch (e) {}
    }
