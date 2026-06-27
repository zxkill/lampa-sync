/*
 * Lampa Sync Player — загрузка прогресса и общие мелкие утилиты.
 *
 * В конце оставлены функции нормализации прогресса, device_id, форматирование
 * времени, HTML-экранирование и Promise-задержка.
 */
    async function loadProgress() {
        try {
            const ids = uniqueProgressIds(progressIds.length ? progressIds : [baseCid]);
            const url = API +
                '?content_id=' + encodeURIComponent(baseCid) +
                '&content_ids=' + encodeURIComponent(ids.join(',')) +
                '&t=' + Date.now();

            const r = await fetch(url, {cache: 'no-store'});
            return r.ok ? await r.json() : null;
        } catch (e) {
            return null;
        }
    }

    // Нормализует прогресс из query/API.
    function normProg(p) {
        if (!p) return null;

        let position = +(p.position || 0);
        const totalDuration = +(p.duration || 0);

        // Защита от старых битых сохранений вида 40:00 / 25:00.
        if (totalDuration > 0 && position > totalDuration + 30) {
            position = 0;
        }

        return {
            position: position,
            duration: totalDuration,
            percent: +(p.percent || 0),
            ended: p.ended === true || p.ended === 1 || p.ended === '1'
        };
    }

    // Создаёт id устройства для записи прогресса.
    function deviceId() {
        let id = localStorage.getItem('lampa_sync_device_id');

        if (!id) {
            id = 'dev_' + Math.random().toString(36).slice(2) + '_' + Date.now();
            localStorage.setItem('lampa_sync_device_id', id);
        }

        return id;
    }

    // Форматирует секунды в HH:MM:SS или MM:SS.
    function fmt(x) {
        x = Math.max(0, Math.floor(x || 0));

        const h = Math.floor(x / 3600);
        const m = Math.floor((x % 3600) / 60);
        const s = x % 60;

        return h > 0
            ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
            : m + ':' + String(s).padStart(2, '0');
    }

    // Экранирует строку для безопасного вывода в HTML.
    function esc(s) {
        return String(s)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;');
    }

    // Promise-задержка для коротких асинхронных пауз.
    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
