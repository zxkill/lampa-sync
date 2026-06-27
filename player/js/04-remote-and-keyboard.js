/*
 * Lampa Sync Player — клавиатура, пробел, media keys и ТВ-пульт.
 *
 * Этот блок принимает события из iframe/родителя, переводит коды клавиш
 * в действия плеера и поддерживает визуальный remote-focus.
 */
    function handleRemoteInput(e) {
        const key = String(e.key || '');
        const code = String(e.code || '');
        const keyCode = Number(e.keyCode || e.which || 0);

        const handled = handleRemoteKey(key, code, keyCode);

        if (handled) {
            stopEvent(e);
        }

        return handled;
    }

    // Преобразует клавиши пульта в действия плеера.
    function handleRemoteKey(key, code, keyCode) {
        const k = key.toLowerCase();

        enableRemoteMode();

        if (isBackKey(k, code, keyCode)) {
            requestClose();
            return true;
        }

        if (isPlayPauseKey(k, code, keyCode)) {
            routeAction('remoteToggle', toggle);
            return true;
        }

        if (isPauseKey(k, code, keyCode)) {
            if (!v.paused) routeAction('remotePause', () => v.pause());
            return true;
        }

        if (isPlayKey(k, code, keyCode)) {
            if (v.paused) routeAction('remotePlay', tryPlay);
            return true;
        }

        if (isStopKey(k, code, keyCode)) {
            requestClose();
            return true;
        }

        if (isLeftKey(k, code, keyCode) || isRewindKey(k, code, keyCode)) {
            routeAction('remoteBack', () => seek(globalTime() - 10));
            setRemoteFocusByName('back');
            return true;
        }

        if (isRightKey(k, code, keyCode) || isForwardKey(k, code, keyCode)) {
            routeAction('remoteFwd', () => seek(globalTime() + 10));
            setRemoteFocusByName('fwd');
            return true;
        }

        if (isUpKey(k, code, keyCode)) {
            moveRemoteFocus(-1);
            return true;
        }

        if (isDownKey(k, code, keyCode)) {
            moveRemoteFocus(1);
            return true;
        }

        if (isOkKey(k, code, keyCode)) {
            /*
             * На ТВ кнопка OK должна вести себя как у обычного плеера:
             * сразу пауза/продолжить, без необходимости выбирать кнопку Play.
             * Фокус по кнопкам оставлен только как визуальная подсказка.
             */
            routeAction('remoteOkToggle', toggle);
            return true;
        }

        if (k === 'f' || keyCode === 122) {
            routeAction('remoteFull', toggleFullscreen);
            setRemoteFocusByName('full');
            return true;
        }

        return false;
    }

    // Включает режим навигации пультом по элементам управления.
    function enableRemoteMode() {
        document.body.classList.add('remote-mode');
        resetHide();
        updateRemoteFocus();

        clearTimeout(remoteModeTimer);
        remoteModeTimer = setTimeout(() => {
            if (!v.paused) {
                document.body.classList.remove('remote-mode');
            }
        }, 7000);
    }

    // Возвращает список фокусируемых элементов для пульта.
    function getRemoteTargets() {
        if (isIPhoneLandscape()) {
            return [
                {el: ipPlay, name: 'play', handler: toggle},
                {el: ipBack, name: 'back', handler: () => seek(globalTime() - 10)},
                {el: ipFwd, name: 'fwd', handler: () => seek(globalTime() + 10)},
                {el: ipFit, name: 'fit', handler: toggleFit},
                {el: ipFull, name: 'full', handler: toggleFullscreen}
            ].filter(item => item.el);
        }

        return [
            {el: play, name: 'play', handler: toggle},
            {el: back, name: 'back', handler: () => seek(globalTime() - 10)},
            {el: fwd, name: 'fwd', handler: () => seek(globalTime() + 10)},
            {el: fit, name: 'fit', handler: toggleFit},
            {el: full, name: 'full', handler: toggleFullscreen},
            {el: prepareBtn, name: 'prepare', handler: togglePrepare},
            {el: closeBtn, name: 'close', handler: requestClose}
        ].filter(item => item.el);
    }

    // Передвигает фокус пульта по панели управления.
    function moveRemoteFocus(delta) {
        const targets = getRemoteTargets();

        if (!targets.length) return;

        remoteFocusIndex = (remoteFocusIndex + delta + targets.length) % targets.length;
        updateRemoteFocus();
    }

    // Ставит фокус пульта на конкретное действие.
    function setRemoteFocusByName(name) {
        const targets = getRemoteTargets();
        const index = targets.findIndex(item => item.name === name);

        if (index >= 0) {
            remoteFocusIndex = index;
            updateRemoteFocus();
        }
    }

    // Синхронизирует CSS-класс фокуса с текущим элементом.
    function updateRemoteFocus() {
        document.querySelectorAll('.remote-focused').forEach(el => {
            el.classList.remove('remote-focused');
        });

        const targets = getRemoteTargets();

        if (!targets.length) return;

        if (remoteFocusIndex < 0 || remoteFocusIndex >= targets.length) {
            remoteFocusIndex = 0;
        }

        const target = targets[remoteFocusIndex];

        if (target && target.el) {
            target.el.classList.add('remote-focused');
        }
    }

    // Подключает стандартные media actions браузера/ТВ.
    // Это помогает обычным media-кнопкам и некоторым голосовым командам ТВ
    // вроде «поставь на паузу» / «продолжить», если оболочка устройства
    // передаёт их веб-странице через Media Session API.
    function setupMediaSession() {
        if (!('mediaSession' in navigator)) return;

        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: title || 'Lampa Sync Player'
            });
        } catch (e) {}

        const handlers = {
            play: () => tryPlay(),
            pause: () => v.pause(),
            seekbackward: details => seek(globalTime() - Number((details && details.seekOffset) || 10)),
            seekforward: details => seek(globalTime() + Number((details && details.seekOffset) || 10)),
            stop: () => requestClose()
        };

        Object.keys(handlers).forEach(action => {
            try {
                navigator.mediaSession.setActionHandler(action, handlers[action]);
            } catch (e) {}
        });

        updateMediaSessionState();
    }

    // Обновляет playbackState для системных media controls.
    function updateMediaSessionState() {
        if (!('mediaSession' in navigator)) return;

        try {
            navigator.mediaSession.playbackState = v.paused ? 'paused' : 'playing';
        } catch (e) {}
    }

    function isOkKey(k, code, keyCode) {
        return k === 'enter' ||
            k === 'ok' ||
            code === 'Enter' ||
            code === 'NumpadEnter' ||
            keyCode === 13 ||
            keyCode === 23 ||
            keyCode === 66;
    }
    function isBackKey(k, code, keyCode) {
        return k === 'escape' ||
            k === 'backspace' ||
            k === 'browserback' ||
            code === 'Escape' ||
            code === 'Backspace' ||
            keyCode === 8 ||
            keyCode === 27 ||
            keyCode === 461 ||
            keyCode === 10009;
    }
    function isLeftKey(k, code, keyCode) {
        return k === 'arrowleft' || code === 'ArrowLeft' || keyCode === 37 || keyCode === 21;
    }
    function isRightKey(k, code, keyCode) {
        return k === 'arrowright' || code === 'ArrowRight' || keyCode === 39 || keyCode === 22;
    }
    function isUpKey(k, code, keyCode) {
        return k === 'arrowup' || code === 'ArrowUp' || keyCode === 38 || keyCode === 19;
    }
    function isDownKey(k, code, keyCode) {
        return k === 'arrowdown' || code === 'ArrowDown' || keyCode === 40 || keyCode === 20;
    }
    function isPlayPauseKey(k, code, keyCode) {
        return k === 'mediaplaypause' ||
            k === ' ' ||
            k === 'spacebar' ||
            code === 'MediaPlayPause' ||
            code === 'Space' ||
            keyCode === 32 ||
            keyCode === 179 ||
            keyCode === 10252;
    }
    function isPlayKey(k, code, keyCode) {
        return k === 'mediaplay' ||
            code === 'MediaPlay' ||
            keyCode === 415;
    }
    function isPauseKey(k, code, keyCode) {
        return k === 'mediapause' ||
            code === 'MediaPause' ||
            keyCode === 19;
    }
    function isStopKey(k, code, keyCode) {
        return k === 'mediastop' ||
            code === 'MediaStop' ||
            keyCode === 413;
    }
    function isRewindKey(k, code, keyCode) {
        return k === 'mediarewind' ||
            code === 'MediaRewind' ||
            keyCode === 412;
    }
    function isForwardKey(k, code, keyCode) {
        return k === 'mediafastforward' ||
            code === 'MediaFastForward' ||
            keyCode === 417;
    }
