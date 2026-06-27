/*
 * Lampa Sync Player — ранние помощники.
 *
 * Этот файл загружается первым, потому что часть переменных состояния ниже
 * сразу вызывает hash(), uniqueProgressIds() и makeSid().
 * Логика не переписана: функции перенесены из прежнего inline-скрипта.
 */

// Убирает пустые и повторяющиеся идентификаторы прогресса.
function uniqueProgressIds(list) {
    const out = [];

    (list || []).forEach(v => {
        const s = String(v || '').trim();
        if (!s || out.includes(s)) return;
        out.push(s);
    });

    return out;
}

// Возвращает content_id варианта видео с выбранной аудиодорожкой.
// Прогресс просмотра остаётся привязан к обычному cid, а HLS/prepared-кэш — к cid+audio.
function mediaContentId() {
    return activeAudioTrack > 0 ? (baseCid + '_a' + activeAudioTrack) : baseCid;
}

// Отдельный sid нужен, чтобы HLS с разными аудиодорожками не смешивался в одной папке.
function makeSid() {
    return 'sid_' + hash(mediaContentId());
}

// Простой hash для идентификаторов плеера.
function hash(s) {
    let h = 0;

    if (!s) return 'empty';

    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h) + s.charCodeAt(i);
        h |= 0;
    }

    return 'c_' + Math.abs(h);
}
