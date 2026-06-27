/*
 * Lampa Sync Player — закрытие, play/pause, fullscreen, fit, HUD и ошибки.
 *
 * Этот файл управляет видимостью интерфейса, фоновым тапом, toast/status/error
 * и базовыми действиями пользователя.
 */
    // Просит родительское окно закрыть iframe-плеер.
    function requestClose() {
        shutdown();

        try {
            window.parent.postMessage({type: 'lampa-sync-request-close'}, '*');
        } catch (e) {}

        setTimeout(() => {
            if (window.parent === window) history.back();
        }, 150);
    }

    // Переключает play/pause.
    function toggle() {
        v.paused ? tryPlay() : v.pause();
    }
    async function tryPlay() {
        try { await v.play(); } catch (e) {}
        state();
    }

    // Обновляет состояние центральной кнопки play/pause.
    function state() {
        const icon = v.paused ? '▶' : 'Ⅱ';
        play.innerText = icon;
        center.innerText = icon;
        if (ipPlay) ipPlay.innerText = icon;
    }

    // Переключает fullscreen.
    function toggleFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        } else if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(() => {});
        }
    }

    // Переключает режим вписывания/заполнения видео.
    function toggleFit() {
        fitMode = fitMode === 'contain' ? 'cover' : 'contain';
        v.style.objectFit = fitMode;
        note(fitMode === 'cover' ? 'Заполнение экрана' : 'По размеру экрана');
    }

    // Обрабатывает тап/клик по свободной области: скрыть интерфейс, если он виден, или показать, если скрыт.
    function handleBackgroundTap(e) {
        if (isUiTarget(e.target)) return;

        const now = Date.now();
        const type = String(e.type || '');

        /*
         * На сенсорных устройствах один тап часто приходит серией событий:
         * touchend -> pointerup -> synthetic click -> иногда mousemove.
         * Если не гасить дубли, первый обработчик скрывает интерфейс, а следующий
         * синтетический event сразу вызывает resetHide() и показывает его обратно.
         */
        if (type === 'touchend') {
            lastBackgroundTouchAt = now;
        } else if (type === 'pointerup') {
            if (now - lastBackgroundTouchAt < 650) {
                stopEvent(e);
                return;
            }
            lastBackgroundTouchAt = now;
        } else if (type === 'click' && now - lastBackgroundTouchAt < 750) {
            stopEvent(e);
            return;
        }

        if (now - lastBackgroundToggleAt < 260) {
            stopEvent(e);
            return;
        }
        lastBackgroundToggleAt = now;

        stopEvent(e);

        if (document.body.classList.contains('clean')) {
            showControlsNow();
        } else {
            hideControlsNow();
        }
    }

    // Немедленно скрывает интерфейс по явному действию пользователя.
    function hideControlsNow() {
        clearTimeout(hideTimer);
        if (err.style.display === 'block') return;

        controlsHiddenByTap = true;
        suppressAutoShowUntil = Date.now() + 900;
        document.body.classList.add('clean');
    }

    // Немедленно показывает интерфейс по явному действию пользователя.
    function showControlsNow() {
        controlsHiddenByTap = false;
        suppressAutoShowUntil = 0;
        resetHide(true);
    }

    // Сбрасывает таймер скрытия интерфейса плеера.
    function resetHide(force = false) {
        if (!force) {
            if (controlsHiddenByTap) return;
            if (Date.now() < suppressAutoShowUntil) return;
        }

        controlsHiddenByTap = false;
        document.body.classList.remove('clean');

        clearTimeout(hideTimer);

        hideTimer = setTimeout(() => {
            if (!v.paused && err.style.display !== 'block') {
                controlsHiddenByTap = false;
                document.body.classList.add('clean');
            }
        }, 3500);
    }

    // Показывает временный статус по центру экрана.
    function showStatus(t) {
        statusBox.classList.remove('hide');
        statusText.innerText = t;
    }

    // Скрывает центральный статус.
    function hideStatus() {
        statusBox.classList.add('hide');
    }

    // Показывает ошибку воспроизведения.
    function showError(m) {
        err.style.display = 'block';
        err.innerHTML = m;
        document.body.classList.remove('clean');
    }

    // Показывает короткий toast.
    function note(m) {
        toast.innerText = m;
        toast.style.display = 'block';
        clearTimeout(note.t);
        note.t = setTimeout(() => toast.style.display = 'none', 1700);
    }

    // Решает, нужно ли проксировать исходный HTTP-поток через HTTPS API.
    function needsProxy(u) {
        return u.startsWith('http://') || u.includes(':8090') || u.includes('/stream/');
    }
