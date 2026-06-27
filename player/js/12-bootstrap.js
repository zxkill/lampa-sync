/*
 * Lampa Sync Player — последняя точка входа.
 *
 * В старом player.html этот код находился сразу после объявления состояния.
 * После разбиения он выполняется последним, чтобы все функции из отдельных
 * файлов уже были объявлены к моменту init().
 */

quality.innerText = activeQuality;
title.innerText = titleText;
updateDeviceClasses();

if (!src) {
    showError('Не передан url');
} else {
    init();
}
