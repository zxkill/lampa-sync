/*
 * Lampa Sync Player — запуск плеера.
 *
 * init() поднимает viewport, состояние подготовки, сохранённый прогресс,
 * обработчики событий, аудиодорожки и затем выбирает Direct или HLS-режим.
 */
    async function init() {
        bindViewport();
        await loadPrepareState();
        renderPrepareButton();
        startPrepareUiTicker();

        saved = normProg(await loadProgress());

        if (saved && saved.duration > 0) {
            duration = saved.duration;
        }

        let resume = saved && !saved.ended && saved.position > 5
            ? Math.max(0, saved.position - 3)
            : 0;

        /*
         * Старые версии prepared-HLS могли сохранить некорректную позицию,
         * потому что offset уже входил в currentTime и затем прибавлялся второй раз.
         * Если позиция явно выходит за длительность — не пытаемся продолжать с неё.
         */
        if (duration > 0 && resume > duration - 2) {
            resume = 0;
        }

        bindEvents();
        await loadAudioTracks();
        await refreshPrepareState(false);

        if (trans || needsProxy(src)) {
            await startHls(resume, true);
        } else {
            await direct(src, resume);
        }

        resetHide();
    }
