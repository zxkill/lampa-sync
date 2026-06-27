/*
 * Lampa Sync Player — мышь, touch, кнопки, iPhone landscape и layout.
 *
 * Здесь собрана маршрутизация кликов/тапов, прогресс-бар, громкость,
 * отдельная iPhone-панель, viewport-переменные и базовые DOM-утилиты.
 */
    // Подписывает кнопки, клавиатуру, сообщения от родительского окна и lifecycle-события.
    function bindEvents() {
        /*
         * Video itself is intentionally not clickable.
         * Background tap toggles UI visibility; play/pause only via buttons/keys.
         */
        app.addEventListener('click', handleBackgroundTap, {capture: true, passive: false});
        app.addEventListener('touchend', handleBackgroundTap, {capture: true, passive: false});
        app.addEventListener('pointerup', handleBackgroundTap, {capture: true, passive: false});

        v.ontimeupdate = () => {
            markGoodPlaybackPosition();

            if (Date.now() - lastSync > 5000) {
                lastSync = Date.now();
                save(false);
            }
            ui();
        };

        v.onplay = v.onpause = () => {
            state();
            updateMediaSessionState();
        };

        setupMediaSession();

        v.onended = () => {
            save(true);
            state();
            updateMediaSessionState();
        };

        v.onerror = () => {
            handleVideoPlaybackError(v.error ? v.error.code : '?');
        };

        bindButton(play, 'play', toggle);
        bindButton(center, 'center', toggle);
        bindButton(back, 'back', () => seek(globalTime() - 10));
        bindButton(fwd, 'fwd', () => seek(globalTime() + 10));
        bindButton(closeBtn, 'close', requestClose);
        bindButton(full, 'full', toggleFullscreen);
        bindButton(fit, 'fit', toggleFit);
        bindButton(prepareBtn, 'prepare', togglePrepare);
        bindButton(queueBtn, 'queue', openPrepareQueue);

        bindVolume();
        bindAudioTrackSelect();
        bindSubtitleTrackSelect();
        bindSubtitleOverlayEvents();
        bindProgress();

        bindLandscapeRouter();
        bindIPhoneControls();

        document.addEventListener('mousemove', resetHide, {passive: true});

        document.addEventListener('keydown', e => {
            handleRemoteInput(e);
        }, true);

        window.addEventListener('message', e => {
            const data = e.data || {};

            if (data.type === 'lampa-sync-close') {
                requestClose();
                return;
            }

            if (data.type === 'lampa-sync-remote-key') {
                handleRemoteInput(data);
            }
        });

        window.addEventListener('beforeunload', shutdown);
        window.addEventListener('pagehide', shutdown);
    }

    // Универсально привязывает кнопку к действию мыши/тача.
    function bindButton(el, name, handler) {
        if (!el) return;

        let last = 0;

        const run = e => {
            stopEvent(e);

            const now = Date.now();
            if (now - last < 260) return;
            last = now;

            routeAction(name, handler);
        };

        el.addEventListener('click', run, {passive: false});
        el.addEventListener('touchend', run, {passive: false});
        el.addEventListener('pointerup', run, {passive: false});

        ['touchstart', 'pointerdown', 'mousedown', 'mouseup'].forEach(type => {
            el.addEventListener(type, e => e.stopPropagation(), {passive: true});
        });
    }

    // Настраивает громкость и mute.
    function bindVolume() {
        if (!vol) return;

        const update = e => {
            e.stopPropagation();
            v.volume = +vol.value;
            v.muted = v.volume <= 0;
        };

        vol.addEventListener('input', update, {passive: true});
        vol.addEventListener('change', update, {passive: true});
        ['touchstart', 'touchend', 'pointerdown', 'pointerup', 'click'].forEach(type => {
            vol.addEventListener(type, e => e.stopPropagation(), {passive: true});
        });
    }

    // Настраивает перемотку по нижнему прогресс-бару.
    function bindProgress() {
        const run = e => {
            if (isIPhoneLandscape()) {
                stopEvent(e);
                resetHide();
                return;
            }

            stopEvent(e);
            seekByPoint(getPoint(e));
        };

        progWrap.addEventListener('click', run, {passive: false});
        progWrap.addEventListener('touchend', run, {passive: false});
        progWrap.addEventListener('pointerup', run, {passive: false});
        ['touchstart', 'pointerdown', 'mousedown'].forEach(type => {
            progWrap.addEventListener(type, e => e.stopPropagation(), {passive: true});
        });
    }

    // Разводит тачи в landscape-режиме iPhone, где элементы часто перекрываются.
    function bindLandscapeRouter() {
        const handler = e => {
            if (!isIPhoneLandscape()) return;

            const point = getPoint(e);
            if (!point) return;

            const h = viewportHeight();
            const bottomZoneTop = h - 150;

            /*
             * Dedicated iPhone landscape layer:
             * bottom 150px belongs only to iPhone panel.
             * No progress/seek can happen here.
             */
            if (point.clientY >= bottomZoneTop) {
                stopEvent(e);
                routeIPhoneByX(point);
                return;
            }

            const closeRect = rect(closeBtn);

            if (inside(point, expand(closeRect, 18))) {
                stopEvent(e);
                routeAction('close', requestClose);
                return;
            }

            // Free background taps are handled by handleBackgroundTap().
        };

        document.addEventListener('touchstart', handler, {capture: true, passive: false});
        document.addEventListener('touchend', handler, {capture: true, passive: false});
        document.addEventListener('pointerdown', handler, {capture: true, passive: false});
        document.addEventListener('pointerup', handler, {capture: true, passive: false});
        document.addEventListener('click', handler, {capture: true, passive: false});
    }


    // Подключает отдельную нижнюю панель управления для iPhone landscape.

    function bindIPhoneControls() {
        bindButton(ipPlay, 'ipPlay', toggle);
        bindButton(ipBack, 'ipBack', () => seek(globalTime() - 10));
        bindButton(ipFwd, 'ipFwd', () => seek(globalTime() + 10));
        bindButton(ipFit, 'ipFit', toggleFit);
        bindButton(ipFull, 'ipFull', toggleFullscreen);

        if (iphonePanel) {
            ['touchstart', 'touchend', 'pointerdown', 'pointerup', 'click'].forEach(type => {
                iphonePanel.addEventListener(type, e => {
                    if (!isIPhoneLandscape()) return;
                    stopEvent(e);
                    routeIPhoneByX(getPoint(e));
                }, {passive: false});
            });
        }
    }

    // Определяет действие iPhone-панели по координате X.
    function routeIPhoneByX(point) {
        if (!point) {
            resetHide();
            return;
        }

        const w = viewportWidth();
        const x = Math.min(w - 1, Math.max(0, point.clientX));
        const segment = Math.max(0, Math.min(4, Math.floor((x / Math.max(1, w)) * 5)));

        if (segment === 0) {
            routeAction('ipPlay', toggle);
        } else if (segment === 1) {
            routeAction('ipBack', () => seek(globalTime() - 10));
        } else if (segment === 2) {
            routeAction('ipFwd', () => seek(globalTime() + 10));
        } else if (segment === 3) {
            routeAction('ipFit', toggleFit);
        } else {
            routeAction('ipFull', toggleFullscreen);
        }
    }

    // Возвращает актуальную ширину viewport с учётом iOS-особенностей.
    function viewportWidth() {
        return (window.visualViewport ? window.visualViewport.width : window.innerWidth) ||
            document.documentElement.clientWidth ||
            0;
    }

    // Определяет, на какую кнопку попал touch/click.
    function findButtonAction(point) {
        const actions = [
            {el: play, name: 'play', handler: toggle},
            {el: back, name: 'back', handler: () => seek(globalTime() - 10)},
            {el: fwd, name: 'fwd', handler: () => seek(globalTime() + 10)},
            {el: fit, name: 'fit', handler: toggleFit},
            {el: full, name: 'full', handler: toggleFullscreen},
            {el: vol, name: 'vol', handler: () => volumeByPoint(point)},
            {el: closeBtn, name: 'close', handler: requestClose}
        ];

        for (const item of actions) {
            if (!item.el) continue;

            if (inside(point, expand(rect(item.el), 12))) {
                return item;
            }
        }

        return null;
    }

    // Определяет кнопку нижней iPhone-панели.
    function findIPhoneBottomAction(point) {
        const actions = [
            {el: play, name: 'play', handler: toggle},
            {el: back, name: 'back', handler: () => seek(globalTime() - 10)},
            {el: fwd, name: 'fwd', handler: () => seek(globalTime() + 10)},
            {el: fit, name: 'fit', handler: toggleFit},
            {el: full, name: 'full', handler: toggleFullscreen}
        ].filter(item => item.el);

        /*
         * First: real button rectangles.
         */
        for (const item of actions) {
            if (inside(point, expand(rect(item.el), 20, 22))) {
                return item;
            }
        }

        /*
         * Fallback for iPhone after rotation:
         * If y is already in the bottom control zone, pick nearest button by X.
         * This avoids accidental seek because progress is disabled here.
         */
        let best = null;
        let bestDistance = Infinity;

        for (const item of actions) {
            const r = rect(item.el);
            const cx = r.left + r.width / 2;
            const distance = Math.abs(point.clientX - cx);

            if (distance < bestDistance) {
                bestDistance = distance;
                best = item;
            }
        }

        return bestDistance <= 76 ? best : null;
    }

    // Выполняет действие и гасит исходное событие.
    function routeAction(name, handler) {
        const now = Date.now();

        if (name === lastRoutedAction && now - lastRoutedAt < 240) {
            return;
        }

        lastRoutedAction = name;
        lastRoutedAt = now;

        resetHide();
        handler();
    }

    // Перематывает видео по позиции клика на прогресс-баре.
    function seekByPoint(point) {
        const d = total();
        if (!d || !point) return;

        const r = rect(prog);
        const p = Math.min(1, Math.max(0, (point.clientX - r.left) / r.width));

        seek(d * p);
    }

    // Меняет громкость по координате на слайдере.
    function volumeByPoint(point) {
        const r = rect(vol);
        const p = Math.min(1, Math.max(0, (point.clientX - r.left) / r.width));

        vol.value = String(p);
        v.volume = p;
        v.muted = p <= 0;
    }

    // Проверяет телефонный landscape-режим.
    function isLandscapePhone() {
        return isIPhoneLandscape();
    }

    // Определяет iPhone/iPod по userAgent/platform.
    function isIPhoneLike() {
        const ua = navigator.userAgent || '';
        const platform = navigator.platform || '';
        const maxTouch = navigator.maxTouchPoints || 0;
        const minScreen = Math.min(screen.width || 0, screen.height || 0);

        return /iPhone|iPod/i.test(ua) ||
            /iPhone|iPod/i.test(platform) ||
            (maxTouch > 0 && minScreen > 0 && minScreen <= 430 && !/iPad/i.test(ua));
    }

    // Проверяет специальный режим iPhone landscape.
    function isIPhoneLandscape() {
        const w = window.visualViewport ? window.visualViewport.width : window.innerWidth;
        const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;

        return isIPhoneLike() && w > h && h <= 540;
    }
    function viewportHeight() {
        return (window.visualViewport ? window.visualViewport.height : window.innerHeight) ||
            document.documentElement.clientHeight ||
            0;
    }

    // Обновляет CSS-классы устройства на body.
    function updateDeviceClasses() {
        const iphone = isIPhoneLike();
        const iphoneLandscape = isIPhoneLandscape();

        document.body.classList.toggle('iphone', iphone);
        document.body.classList.toggle('iphone-landscape', iphoneLandscape);
    }

    // Отслеживает resize/orientationchange и обновляет CSS-переменные viewport.
    function bindViewport() {
        const apply = () => {
            const w = Math.round((window.visualViewport ? window.visualViewport.width : window.innerWidth) || document.documentElement.clientWidth || 0);
            const h = Math.round((window.visualViewport ? window.visualViewport.height : window.innerHeight) || document.documentElement.clientHeight || 0);

            if (w > 0) document.documentElement.style.setProperty('--vw', w + 'px');
            if (h > 0) document.documentElement.style.setProperty('--vh', h + 'px');

            updateDeviceClasses();
            updateRemoteFocus();

            document.body.classList.remove('clean');
            setTimeout(resetHide, 250);
        };

        apply();

        window.addEventListener('resize', apply, {passive: true});
        window.addEventListener('orientationchange', () => {
            setTimeout(apply, 60);
            setTimeout(apply, 300);
            setTimeout(apply, 900);
        }, {passive: true});

        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', apply, {passive: true});
            window.visualViewport.addEventListener('scroll', apply, {passive: true});
        }
    }
    function rect(el) {
        return el.getBoundingClientRect();
    }
    function expand(r, x, y) {
        y = typeof y === 'number' ? y : x;

        return {
            left: r.left - x,
            right: r.right + x,
            top: r.top - y,
            bottom: r.bottom + y,
            width: r.width + x * 2,
            height: r.height + y * 2
        };
    }
    function inside(point, r) {
        return point.clientX >= r.left &&
            point.clientX <= r.right &&
            point.clientY >= r.top &&
            point.clientY <= r.bottom;
    }
    function getPoint(e) {
        if (e && e.changedTouches && e.changedTouches[0]) return e.changedTouches[0];
        if (e && e.touches && e.touches[0]) return e.touches[0];
        return e;
    }
    function stopEvent(e) {
        if (!e) return;

        if (e.cancelable && typeof e.preventDefault === 'function') {
            e.preventDefault();
        }

        if (typeof e.stopPropagation === 'function') {
            e.stopPropagation();
        }

        if (typeof e.stopImmediatePropagation === 'function') {
            e.stopImmediatePropagation();
        }
    }
    function isUiTarget(target) {
        return !!(target && target.closest && target.closest('#top, #controls, #row, #progWrap, #iphonePanel, #iphoneHud, #status, #err, #toast, button, input, .btn, .iphoneBtn'));
    }


    // Принимает события пульта/клавиатуры из родительского окна Lampa.
