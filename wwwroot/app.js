import { initializeI18n, changeLanguage, t, locale, hasTranslation, withLanguage } from '/i18n.js?v=20261010-language';
import { createEditSync } from '/edit-sync.js?v=20261010-refactor-sync';
import { bindFilePicker } from '/file-picker.js?v=20261013';

await initializeI18n();

const $ = (id) => document.getElementById(id);
const viewer = location.pathname.startsWith('/view');
document.body.classList.toggle('viewer', viewer);
if (viewer) document.querySelector('.preview-monitor').setAttribute('aria-label', t('monitor.viewerLabel'));
$(viewer ? 'view-tab' : 'edit-tab').classList.add('active');
$(viewer ? 'view-tab' : 'edit-tab').setAttribute('aria-current', 'page');
document.title = t('page.title', { mode: t(viewer ? 'navigation.view' : 'navigation.edit') });

let state = { revision: -1, elements: [] };
let selectedId = null;
let connected = false;
let serverOffset = 0;
let stageScale = 1;
let gesture = null;
let noticeTimer;
let alarmSaving = false;
let alarmFormDirty = false;
let shownAlarmId = null;
let scriptBusy = false;
let scriptLoadingId = null;
let imageBusy = false;
let displayBusy = false;
let deleteConfirmId = null;
let canvasSaving = false;
let orderBusy = false;
let addBusy = false;
let settingsBusy = false;
const canvasWidth = () => state.canvas?.width ?? 1280;
const canvasHeight = () => state.canvas?.height ?? 720;
const editSync = createEditSync({
    sendPatch: (id, patch) => requestJson(`/api/elements/${id}`, 'PATCH', patch),
    isConnected: () => connected,
    onChange: () => render(),
    onError: error => notify(error.message)
});
const nodes = new Map();
const programNodes = new Map();
const scriptLimits = new Map();
const programScriptLimits = new Map();
const kinds = { text: 'kind.text', clock: 'kind.clock', image: 'kind.image', script: 'kind.script', alarm: 'kind.alarm' };
const maxFileBytes = 1024 ** 3;
const fields = { text: 'text', 'font-size': 'fontSize', color: 'color', align: 'align', x: 'x', y: 'y', width: 'width', height: 'height' };
let flipX = false;
let flipY = false;
try {
    flipX = localStorage.getItem('prompter.flipX') === 'true';
    flipY = localStorage.getItem('prompter.flipY') === 'true';
} catch { /* Display still works when browser storage is disabled. */ }

function notify(message) {
    clearTimeout(noticeTimer);
    $('notice').textContent = message;
    $('notice').hidden = false;
    noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 6500);
}

async function request(path, options = {}) {
    const response = await requestResponse(path, options);
    return response.status === 204 ? null : response.json();
}

function requestJson(path, method, body) {
    return request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function requestResponse(path, options = {}) {
    const response = await fetch(path, options);
    if (!response.ok) {
        let message = t('errors.request');
        try {
            const problem = await response.json();
            message = problem.errorKey && hasTranslation(problem.errorKey) ? t(problem.errorKey) : problem.error || message;
        } catch { /* Non-JSON server error. */ }
        throw new Error(message);
    }
    return response;
}

function effectiveElement(element) {
    const patch = editSync.patchFor(element.id);
    const result = { ...element, ...patch };
    if (typeof patch.visible === 'boolean') result.displaySchedule = null;
    result.width = Math.max(80, Math.min(canvasWidth(), result.width));
    result.height = Math.max(48, Math.min(canvasHeight(), result.height));
    result.x = Math.max(0, Math.min(canvasWidth() - result.width, result.x));
    result.y = Math.max(0, Math.min(canvasHeight() - result.height, result.y));
    return result;
}

function selectedElement() {
    const element = state.elements.find((item) => item.id === selectedId);
    return element ? effectiveElement(element) : null;
}

function elementActionBusy(id) {
    return !connected || settingsBusy || canvasSaving || scriptBusy || gesture?.id === id || editSync.hasChanges(id);
}

function displayActionBusy(id) {
    return displayBusy || elementActionBusy(id);
}

function canvasActionBusy() {
    return !connected || settingsBusy || canvasSaving || editSync.sending || editSync.hasPending || !!gesture;
}

function orderActionBusy() {
    return !connected || settingsBusy || orderBusy || !!gesture || canvasSaving;
}

function queuePatch(id, patch) {
    if (!connected || settingsBusy || canvasSaving || scriptLoadingId === id || !state.elements.some((element) => element.id === id)) return;
    if (deleteConfirmId === id) deleteConfirmId = null;
    editSync.queue(id, patch);
}

function select(id) {
    if (id !== selectedId) {
        deleteConfirmId = null;
        alarmFormDirty = false;
        shownAlarmId = null;
    }
    if (id !== selectedId && $('property-fields').contains(document.activeElement)) document.activeElement.blur();
    selectedId = id;
    render();
}

function createElementNode(element, editable) {
    const node = document.createElement('div');
    node.className = `element element-${element.kind}`;
    node.dataset.id = element.id;
    const content = document.createElement('div');
    content.className = 'element-content';
    if (element.kind === 'script') {
        const script = document.createElement('div');
        script.className = 'script-text';
        content.append(script);
    }
    if (element.kind === 'image') {
        const image = document.createElement('img');
        image.src = element.imageUrl;
        image.alt = t('image.alt');
        image.setAttribute('data-i18n-alt', 'image.alt');
        content.append(image);
    }
    node.append(content);
    if (editable) {
        const handle = document.createElement('button');
        handle.className = 'resize-handle';
        handle.title = t('resize.title');
        handle.setAttribute('data-i18n-title', 'resize.title');
        handle.setAttribute('aria-label', t('resize.label'));
        handle.setAttribute('data-i18n-aria-label', 'resize.label');
        node.append(handle);
        node.addEventListener('pointerdown', startGesture);
        node.addEventListener('pointermove', moveGesture);
        node.addEventListener('pointerup', endGesture);
        node.addEventListener('pointercancel', endGesture);
        node.addEventListener('lostpointercapture', endGesture);
    }
    return node;
}

function renderElement(node, element, editable, limits, layer) {
    const visible = elementIsVisible(element);
    node.hidden = !editable && !visible;
    node.classList.toggle('off-air', editable && !visible);
    node.dataset.previewState = displayIsWaiting(element) ? t('state.scheduled') : t('state.hidden');
    node.style.left = `${element.x}px`;
    node.style.top = `${element.y}px`;
    node.style.zIndex = layer;
    node.style.width = `${element.width}px`;
    node.style.height = `${element.height}px`;
    node.style.fontSize = `${element.fontSize}px`;
    node.style.color = element.color;
    node.style.textAlign = element.align;
    node.classList.toggle('selected', editable && element.id === selectedId);
    if (element.kind === 'text') node.firstElementChild.textContent = element.text;
    if (element.kind === 'image') {
        const image = node.firstElementChild.firstElementChild;
        if (image.getAttribute('src') !== element.imageUrl) image.src = element.imageUrl;
    }
    if (element.kind === 'alarm') renderAlarmElement(node, element, editable);
    if (element.kind === 'script') {
        const script = node.firstElementChild.firstElementChild;
        if (script.textContent !== element.text) script.textContent = element.text;
        if (!node.hidden) limits.set(element.id, Math.max(0, script.scrollHeight - element.height));
    }
    if (editable) node.lastElementChild.hidden = element.id !== selectedId;
}

function render() {
    renderSyncStatus();
    resizeStage();
    if (!viewer) renderSettingsControls();
    if (!viewer) renderCanvasControls();
    const liveIds = new Set(state.elements.map((element) => element.id));
    if (selectedId && !liveIds.has(selectedId)) selectedId = null;
    for (const collection of [nodes, programNodes]) {
        for (const [id, node] of collection) {
            if (!liveIds.has(id)) {
                node.remove();
                collection.delete(id);
                scriptLimits.delete(id);
                programScriptLimits.delete(id);
                editSync.discard(id);
            }
        }
    }
    for (const [index, original] of state.elements.entries()) {
        const layer = String(state.elements.length - index);
        const element = effectiveElement(original);
        if (!nodes.has(element.id)) {
            const node = createElementNode(element, !viewer);
            nodes.set(element.id, node);
            $('stage').append(node);
        }
        renderElement(nodes.get(element.id), element, !viewer, scriptLimits, layer);
        if (!viewer) {
            if (!programNodes.has(original.id)) {
                const node = createElementNode(original, false);
                programNodes.set(original.id, node);
                $('program-stage').append(node);
            }
            // Program uses the shared state, just like the viewer, rather than unsent edits.
            renderElement(programNodes.get(original.id), original, false, programScriptLimits, layer);
        }
    }
    updateClocks();
    if (!viewer) {
        renderList();
        renderProperties();
    }
}

function renderList() {
    $('element-count').textContent = t('elements.count', { count: state.elements.length, limit: 20 });
    const fragment = document.createDocumentFragment();
    for (const [index, original] of state.elements.entries()) {
        const element = effectiveElement(original);
        const row = document.createElement('div');
        row.className = `element-row${element.id === selectedId ? ' active' : ''}`;
        const button = document.createElement('button');
        button.className = 'element-select';
        button.type = 'button';
        button.setAttribute('aria-pressed', String(element.id === selectedId));
        const label = document.createElement('span');
        label.textContent = ['text', 'script', 'alarm'].includes(element.kind)
            ? t('elements.rowWithText', { kind: t(kinds[element.kind]), text: element.text.split('\n')[0] || t('elements.emptyText') }) : t(kinds[element.kind]);
        const visibility = document.createElement('small');
        visibility.textContent = displayIsWaiting(element) ? t('state.scheduled') : elementIsVisible(element) ? t('state.visible') : t('state.hidden');
        button.append(label, visibility);
        button.addEventListener('click', () => select(element.id));
        row.append(button);
        const order = document.createElement('div');
        order.className = 'layer-controls';
        for (const [offset, symbol, key] of [[-1, '↑', 'elements.moveUp'], [1, '↓', 'elements.moveDown']]) {
            const move = document.createElement('button');
            move.type = 'button';
            move.textContent = symbol;
            move.title = t(key);
            move.setAttribute('aria-label', t(key));
            move.disabled = orderActionBusy()
                || (offset < 0 ? index === 0 : index === state.elements.length - 1);
            move.addEventListener('click', () => moveElement(element.id, offset));
            order.append(move);
        }
        row.append(order);
        fragment.append(row);
    }
    $('element-list').replaceChildren(fragment);
}

async function moveElement(id, offset) {
    if (orderActionBusy()) return;
    orderBusy = true;
    renderList();
    try {
        const snapshot = await requestJson(`/api/elements/${id}/order`, 'POST', { offset });
        acceptState(snapshot);
    } catch (error) { notify(error.message); }
    finally { orderBusy = false; renderList(); }
}

function renderProperties() {
    const element = selectedElement();
    $('property-fields').hidden = !element;
    $('property-fields').disabled = !connected || settingsBusy || canvasSaving || element?.id === scriptLoadingId;
    $('selection-empty').hidden = !!element;
    $('property-title').textContent = element ? t('properties.kindTitle', { kind: t(kinds[element.kind]) }) : t('properties.title');
    if (!element) return;
    $('x').max = canvasWidth() - element.width;
    $('y').max = canvasHeight() - element.height;
    $('width').max = canvasWidth();
    $('height').max = canvasHeight();
    $('text-fields').hidden = !['text', 'script', 'alarm'].includes(element.kind);
    $('text-label').textContent = element.kind === 'alarm' ? t('alarm.message') : t('properties.text');
    if (element.kind === 'script') $('text').removeAttribute('maxlength');
    else $('text').maxLength = 4000;
    $('script-fields').hidden = element.kind !== 'script';
    $('script-file-fields').hidden = element.kind !== 'script';
    $('image-fields').hidden = element.kind !== 'image';
    $('replace-image').disabled = !connected || settingsBusy || imageBusy;
    $('type-fields').hidden = element.kind === 'image';
    for (const [id, property] of Object.entries(fields)) {
        const input = $(id);
        if (document.activeElement === input) continue;
        input.value = element[property];
    }
    renderScriptControls();
    renderDisplayControls();
}

function displayIsWaiting(element) {
    return !!element.displaySchedule && Date.parse(element.displaySchedule.at) > Date.now() + serverOffset;
}

function elementIsVisible(element) {
    return element.visible && (!displayIsWaiting(element) || (element.kind === 'alarm' && element.showCountdown));
}

function remainingTime(element) {
    const seconds = Math.max(0, Math.ceil((Date.parse(element.displaySchedule.at) - Date.now() - serverOffset) / 1000));
    const pad = value => String(value).padStart(2, '0');
    return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

function renderAlarmElement(node, element, editable) {
    const counting = displayIsWaiting(element) && element.showCountdown;
    const content = node.firstElementChild;
    const label = counting ? t('alarm.countdownLabel') : t('kind.alarm');
    if (content.dataset.alarmLabel !== label) content.dataset.alarmLabel = label;
    const message = counting ? remainingTime(element) : element.text;
    if (content.textContent !== message) content.textContent = message;
    node.classList.toggle('counting-down', counting);
    if (!editable) node.setAttribute('role', counting ? 'timer' : 'alert');
}

function updateScheduledVisibility() {
    let changed = false;
    for (const original of state.elements) {
        const element = effectiveElement(original);
        const node = nodes.get(element.id);
        if (!node) continue;
        if (element.kind === 'alarm') {
            const wasCounting = node.classList.contains('counting-down');
            renderAlarmElement(node, element, !viewer);
            if (wasCounting !== node.classList.contains('counting-down')) changed = true;
            if (!viewer && programNodes.has(element.id)) renderAlarmElement(programNodes.get(element.id), original, false);
        }
        const offAir = !elementIsVisible(element);
        if (!viewer) {
            if (node.classList.contains('off-air') !== offAir) changed = true;
            node.classList.toggle('off-air', offAir);
            node.dataset.previewState = displayIsWaiting(element) ? t('state.scheduled') : t('state.hidden');
        }
        const output = viewer ? node : programNodes.get(element.id);
        const hidden = !elementIsVisible(viewer ? element : original);
        if (!output || output.hidden === hidden) continue;
        output.hidden = hidden;
        if (!hidden && element.kind === 'script')
            (viewer ? scriptLimits : programScriptLimits).set(element.id, Math.max(0, output.firstElementChild.firstElementChild.scrollHeight - (viewer ? element.height : original.height)));
        changed = true;
    }
    if (changed && !viewer) { renderList(); renderProperties(); }
}

function renderDisplayControls() {
    const element = selectedElement();
    if (viewer || !element) return;
    const waiting = displayIsWaiting(element);
    const visible = element.visible && !waiting;
    const onProgram = elementIsVisible(element);
    const alarm = element.kind === 'alarm';
    const busy = displayActionBusy(element.id);
    $('display-schedule-fields').hidden = alarm;
    $('alarm-settings').hidden = !alarm;
    $('alarm-at').disabled = busy || visible;
    $('schedule-alarm').disabled = busy || visible;
    $('alarm-countdown').disabled = busy;
    if (document.activeElement !== $('alarm-countdown')) $('alarm-countdown').value = String(!!element.showCountdown);
    $('schedule-alarm').textContent = waiting ? t('alarm.changeSchedule') : t('alarm.schedule');
    if (alarm) {
        const alarmKey = `${element.id}/${element.displaySchedule?.id ?? ''}`;
        if (shownAlarmId !== alarmKey && !alarmFormDirty) {
            shownAlarmId = alarmKey;
            $('alarm-at').value = localDateTimeValue(element.displaySchedule
                ? new Date(element.displaySchedule.at) : new Date(Date.now() + serverOffset + 5 * 60_000));
        }
    }
    for (const id of ['display-delay', 'display-unit', 'schedule-display']) $(id).disabled = busy || visible;
    $('toggle-visibility').disabled = busy;
    $('toggle-visibility').classList.toggle('primary', !onProgram);
    $('cancel-display').disabled = busy;
    $('delete-element').disabled = busy;
    $('confirm-delete').disabled = busy;
    $('delete-element').hidden = deleteConfirmId === element.id;
    $('delete-confirmation').hidden = deleteConfirmId !== element.id;
    $('cancel-display').hidden = !waiting;
    $('toggle-visibility').textContent = onProgram
        ? t(waiting ? 'display.hideCancelSchedule' : 'display.hide')
        : t(waiting ? 'display.showCancelSchedule' : 'display.show');
    $('schedule-display').textContent = waiting ? t('display.changeSchedule') : t('display.schedule');
    const status = t('display.programState', { state: t(waiting ? alarm && element.showCountdown ? 'state.countdown' : 'state.scheduled' : visible ? 'state.onAir' : 'state.hidden') });
    if ($('display-state').textContent !== status) $('display-state').textContent = status;
    $('display-state').className = `display-state ${waiting ? 'waiting' : visible ? 'visible' : ''}`;
    $('display-status').textContent = alarm
        ? waiting ? t('alarm.waiting', { remaining: remainingTime(element), date: alarmFormatter.format(new Date(element.displaySchedule.at)) })
            : visible ? t('alarm.hideBeforeSchedule') : t('alarm.hiddenUntilSchedule')
        : waiting
        ? t('display.waiting', { seconds: Math.ceil((Date.parse(element.displaySchedule.at) - Date.now() - serverOffset) / 1000) })
        : visible ? t('display.hideBeforeSchedule') : t('display.hiddenUntilSchedule');
}

function toggleElementVisibility() {
    const element = selectedElement();
    if (!element || displayActionBusy(element.id)) return;
    queuePatch(element.id, { visible: !elementIsVisible(element) });
    void editSync.flush();
}

async function scheduleDisplay(cancel = false) {
    const element = selectedElement();
    if (!element || displayActionBusy(element.id)) return;
    if (!cancel && elementIsVisible(element)) return;
    const seconds = Number($('display-delay').value) * Number($('display-unit').value);
    if (!cancel && (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400 || !$('display-delay').checkValidity())) {
        notify(t('errors.displayDelay'));
        return;
    }
    if (cancel && !element.displaySchedule) return;
    displayBusy = true;
    renderDisplayControls();
    try {
        const path = `/api/elements/${element.id}/display-schedule`;
        if (cancel) await request(`${path}/${element.displaySchedule.id}`, { method: 'DELETE' });
        else await requestJson(path, 'POST', { delaySeconds: seconds });
        await refreshBoard();
    } catch (error) { notify(error.message); }
    finally { displayBusy = false; renderDisplayControls(); }
}

async function scheduleAlarm() {
    const element = selectedElement();
    if (element?.kind !== 'alarm' || displayActionBusy(element.id) || (element.visible && !displayIsWaiting(element))) return;
    const date = new Date($('alarm-at').value);
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now() + serverOffset) {
        notify(t('errors.alarmFuture'));
        return;
    }
    displayBusy = true;
    renderDisplayControls();
    try {
        await requestJson(`/api/elements/${element.id}/alarm`, 'PUT', { at: date.toISOString() });
        alarmFormDirty = false;
        await refreshBoard();
    } catch (error) { notify(error.message); }
    finally { displayBusy = false; renderDisplayControls(); }
}

function scriptPosition(element) {
    const playback = element.playback;
    return playback.offset + (playback.startedAt
        ? Math.max(0, (Date.now() + serverOffset - Date.parse(playback.startedAt)) / 1000) * playback.speed : 0);
}

function renderScriptControls() {
    const element = selectedElement();
    if (viewer || element?.kind !== 'script') return;
    const limit = scriptLimits.get(element.id) ?? 0;
    const waiting = displayIsWaiting(element);
    const ended = !waiting && scriptPosition(element) >= limit;
    const busy = elementActionBusy(element.id);
    const running = !!element.playback.startedAt;
    $('replace-script').disabled = busy;
    $('script-play').disabled = busy || running || ended;
    $('script-pause').disabled = busy || !running;
    $('script-reset').disabled = busy;
    $('script-speed').disabled = busy;
    if (document.activeElement !== $('script-speed')) {
        $('script-speed').value = element.playback.speed;
        $('script-speed-value').textContent = t('script.speedValue', { speed: element.playback.speed });
    }
    const status = waiting ? (running ? t('script.waitingPlaying') : t('script.waitingStopped'))
        : limit === 0 ? t('script.fits')
        : ended ? t('script.ended')
        : running ? t('script.playing') : t('script.stopped');
    if ($('script-status').textContent !== status) $('script-status').textContent = status;
}

function animateScripts() {
    for (const element of state.elements) {
        if (element.kind !== 'script' || !nodes.has(element.id)) continue;
        const offset = Math.min(scriptLimits.get(element.id) ?? 0, scriptPosition(element));
        nodes.get(element.id).firstElementChild.firstElementChild.style.transform = `translateY(-${offset.toFixed(2)}px)`;
        const output = programNodes.get(element.id);
        if (output) {
            const programOffset = Math.min(programScriptLimits.get(element.id) ?? 0, scriptPosition(element));
            output.firstElementChild.firstElementChild.style.transform = `translateY(-${programOffset.toFixed(2)}px)`;
        }
    }
    requestAnimationFrame(animateScripts);
}

async function controlScript(action, speed) {
    const element = selectedElement();
    if (element?.kind !== 'script' || elementActionBusy(element.id)) return;
    scriptBusy = true;
    renderScriptControls();
    try {
        await requestJson(`/api/elements/${element.id}/playback`, 'POST', { action, speed });
        await refreshBoard();
    } catch (error) { notify(error.message); }
    finally { scriptBusy = false; renderScriptControls(); }
}

function startGesture(event) {
    if (!connected || settingsBusy || canvasSaving || event.button !== 0 || gesture) return;
    const node = event.currentTarget;
    const element = state.elements.find((item) => item.id === node.dataset.id);
    if (!element) return;
    event.preventDefault();
    select(element.id);
    gesture = {
        id: element.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
        element: effectiveElement(element), resize: event.target.classList.contains('resize-handle')
    };
    node.setPointerCapture(event.pointerId);
    renderList();
    renderProperties();
    renderCanvasControls();
}

function moveGesture(event) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = (event.clientX - gesture.startX) / stageScale;
    const dy = (event.clientY - gesture.startY) / stageScale;
    const { element, id, resize } = gesture;
    const clamp = (value, min, max) => Math.round(Math.max(min, Math.min(max, value)));
    queuePatch(id, resize ? {
        width: clamp(element.width + dx, 80, canvasWidth() - element.x),
        height: clamp(element.height + dy, 48, canvasHeight() - element.y)
    } : {
        x: clamp(element.x + dx, 0, canvasWidth() - element.width),
        y: clamp(element.y + dy, 0, canvasHeight() - element.height)
    });
    // Limit live drag updates to about ten per second without waiting for the drag to finish.
    if (!editSync.sending && performance.now() - (gesture.lastSent || 0) > 100) {
        gesture.lastSent = performance.now();
        void editSync.flush();
    }
}

function endGesture(event) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gesture = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    void editSync.flush();
    renderList();
    renderProperties();
    renderCanvasControls();
}

function fitStage(hostId, viewportId, stageId, output = false) {
    const host = $(hostId);
    const style = getComputedStyle(host);
    const availableWidth = host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const availableHeight = host.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const fitHeight = viewer || document.fullscreenElement || style.getPropertyValue('--fit-stage-height').trim() === '1';
    const width = canvasWidth(), height = canvasHeight();
    const scale = Math.max(.01, Math.min(availableWidth / width, fitHeight ? availableHeight / height : Infinity));
    $(viewportId).style.width = `${width * scale}px`;
    $(viewportId).style.height = `${height * scale}px`;
    $(stageId).style.width = `${width}px`;
    $(stageId).style.height = `${height}px`;
    $(stageId).style.backgroundColor = state.canvas?.backgroundColor ?? '#000000';
    $(viewportId).style.backgroundColor = state.canvas?.backgroundColor ?? '#000000';
    $(stageId).style.transform = `scale(${scale})`;
    $(viewportId).style.transform = viewer ? `scale(${flipX ? -1 : 1}, ${flipY ? -1 : 1})` : '';
    if (!output) stageScale = scale;
}

function resizeStage() {
    fitStage('stage-host', 'stage-viewport', 'stage');
    if (!viewer) fitStage('program-host', 'program-viewport', 'program-stage', true);
}

let clockFormatter = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
let alarmFormatter = new Intl.DateTimeFormat(locale, {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
function updateClocks() {
    const time = clockFormatter.format(new Date(Date.now() + serverOffset));
    for (const element of state.elements) {
        if (element.kind === 'clock') {
            nodes.get(element.id).firstElementChild.textContent = time;
            if (!viewer) programNodes.get(element.id).firstElementChild.textContent = time;
        }
    }
    renderAlarm();
    updateScheduledVisibility();
    renderScriptControls();
    renderDisplayControls();
    if (!viewer) renderSettingsControls();
}

function localDateTimeValue(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function renderAlarm() {
    const alarms = state.elements.filter((element) => element.kind === 'alarm');
    const active = alarms.filter(element => elementIsVisible(element) && !displayIsWaiting(element));
    const waiting = alarms.filter(displayIsWaiting);
    $('viewer-alarm-status').textContent = active.length ? t('viewer.alarmActive', { count: active.length })
        : waiting.length ? t('viewer.alarmWaiting', { count: waiting.length }) : '';
    $('stop-alarm').hidden = active.length === 0;
    $('stop-alarm').textContent = active.length > 1 ? t('viewer.stopAllAlarms') : t('viewer.stopAlarm');
    $('stop-alarm').disabled = !connected || alarmSaving;
}

async function clearAlarm() {
    if (!connected || alarmSaving) return;
    const alarms = state.elements.filter((element) => element.kind === 'alarm' && elementIsVisible(element) && !displayIsWaiting(element));
    if (!alarms.length) return;
    alarmSaving = true;
    renderAlarm();
    try {
        for (const element of alarms) {
            // The schedule ID prevents an old stop action from cancelling a newer reservation.
            if (element.displaySchedule)
                await request(`/api/elements/${element.id}/display-schedule/${element.displaySchedule.id}`, { method: 'DELETE' });
            else await requestJson(`/api/elements/${element.id}`, 'PATCH', { visible: false });
        }
        await refreshBoard();
    } catch (error) { notify(error.message); }
    finally { alarmSaving = false; renderAlarm(); }
}

async function addElement(kind) {
    if (!connected || settingsBusy || addBusy) return;
    addBusy = true;
    renderSettingsControls();
    try {
        const element = await requestJson('/api/elements', 'POST', {
            kind, ...(kind === 'alarm' ? { text: t('alarm.defaultMessage') } : {})
        });
        // The next event supplies the shared state; fetch also covers a delayed event connection.
        await refreshBoard();
        select(element.id);
    } catch (error) { notify(error.message); }
    finally { addBusy = false; renderSettingsControls(); }
}

function acceptState(snapshot) {
    if (snapshot.revision < state.revision) return;
    state = snapshot;
    serverOffset = snapshot.serverTime - Date.now();
    render();
}

async function refreshBoard() { acceptState(await request('/api/board')); }

function settingsActionBusy() {
    return canvasActionBusy() || addBusy || displayBusy || scriptBusy || imageBusy || alarmSaving || orderBusy;
}

function renderSettingsControls() {
    const busy = settingsActionBusy();
    $('download-settings').disabled = busy;
    $('upload-settings').disabled = busy;
    for (const id of ['add-clock', 'add-text', 'add-alarm']) $(id).disabled = !connected || settingsBusy || addBusy;
    $('add-image').disabled = !connected || settingsBusy || imageBusy;
    $('add-script').disabled = !connected || settingsBusy || scriptBusy;
}

async function downloadSettings() {
    if (settingsActionBusy()) return;
    settingsBusy = true;
    render();
    try {
        const response = await requestResponse('/api/settings/download');
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a');
        link.href = url;
        link.download = 'StreamPrompter-settings.zip';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) { notify(error.message); }
    finally { settingsBusy = false; render(); }
}

async function uploadSettings(file) {
    if (!file || settingsActionBusy()) return;
    if (!window.confirm(t('settings.restoreConfirm', { file: file.name }))) return;
    if (settingsActionBusy()) return;
    settingsBusy = true;
    render();
    try {
        const snapshot = await request('/api/settings/upload', {
            method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file
        });
        selectedId = null;
        deleteConfirmId = null;
        alarmFormDirty = false;
        shownAlarmId = null;
        acceptState(snapshot);
        notify(t('settings.restored'));
    } catch (error) { notify(error.message); }
    finally { settingsBusy = false; render(); }
}

function renderCanvasControls() {
    $('aspect-ratio').value = state.canvas?.aspectRatio ?? '16:9';
    $('background-color').value = state.canvas?.backgroundColor ?? '#000000';
    for (const id of ['aspect-ratio', 'background-color'])
        $(id).disabled = canvasActionBusy();
}

async function updateCanvas(patch) {
    if (canvasActionBusy()) return;
    canvasSaving = true;
    render();
    try {
        await requestJson('/api/canvas', 'PATCH', patch);
        await refreshBoard();
    } catch (error) { notify(error.message); }
    finally { canvasSaving = false; render(); }
}

function renderSyncStatus() {
    $('connection').textContent = connected ? t('connection.connected') : t('connection.reconnecting');
    $('connection').className = `connection ${connected ? 'connected' : 'disconnected'}`;
    $('save-status').textContent = !connected ? t('connection.checking')
        : editSync.hasPending || editSync.sending ? t('save.pending') : t('save.automatic');
}

function setConnection(value) {
    const changed = connected !== value;
    connected = value;
    renderSyncStatus();
    if (!viewer) {
        renderSettingsControls();
        renderCanvasControls();
        renderProperties();
        if (changed) renderList();
    }
    renderAlarm();
}

const events = new EventSource('/api/events');
events.onopen = () => { state = { ...state, revision: -1 }; };
events.onmessage = (event) => {
    acceptState(JSON.parse(event.data));
    setConnection(true);
};
events.onerror = () => {
    setConnection(false);
    if (editSync.hasPending) {
        editSync.clearPending();
        notify(t('connection.lostChanges'));
        render();
    }
};

async function uploadImage(file, id = null) {
    if (!file || !connected || settingsBusy || imageBusy) return;
    imageBusy = true;
    $('add-image').disabled = true;
    renderProperties();
    try {
        if (file.size <= 0 || file.size > maxFileBytes) throw new Error(t('errors.imageSize'));
        const form = new FormData();
        form.append('file', file);
        const element = await request(id ? `/api/images/${id}` : '/api/images', {
            method: id ? 'PUT' : 'POST', body: form
        });
        await refreshBoard();
        if (!id) select(element.id);
    } catch (error) { notify(error.message); }
    finally {
        imageBusy = false;
        $('add-image').disabled = !connected || settingsBusy;
        renderProperties();
    }
}

async function loadScriptFile(file, id = null) {
    if (!file || !connected || settingsBusy || scriptBusy || (id && elementActionBusy(id))) return;
    scriptBusy = true;
    scriptLoadingId = id;
    $('add-script').disabled = true;
    renderProperties();
    try {
        if (!/\.txt$/i.test(file.name) || file.size > maxFileBytes) throw new Error(t('errors.scriptFile'));
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
        catch { throw new Error(t('errors.scriptEncoding')); }
        text = text.replace(/\r\n?/g, '\n');
        if (!text.trim()) throw new Error(t('errors.scriptEmpty'));
        const element = await requestJson(id ? `/api/elements/${id}` : '/api/elements',
            id ? 'PATCH' : 'POST', id ? { text } : { kind: 'script', text });
        await refreshBoard();
        if (!id) select(element.id);
    } catch (error) { notify(error.message); }
    finally {
        scriptBusy = false;
        scriptLoadingId = null;
        $('add-script').disabled = !connected || settingsBusy;
        renderProperties();
    }
}

if (!viewer) {
    $('download-settings').addEventListener('click', downloadSettings);
    bindFilePicker($('upload-settings'), $('settings-file'), uploadSettings, { canOpen: () => !settingsActionBusy() });
    $('aspect-ratio').addEventListener('change', () => updateCanvas({ aspectRatio: $('aspect-ratio').value }));
    $('background-color').addEventListener('change', () => updateCanvas({ backgroundColor: $('background-color').value }));
    $('toggle-visibility').addEventListener('click', toggleElementVisibility);
    $('schedule-display').addEventListener('click', () => scheduleDisplay());
    $('cancel-display').addEventListener('click', () => scheduleDisplay(true));
    $('display-unit').addEventListener('change', () => { $('display-delay').max = 86400 / Number($('display-unit').value); });
    bindFilePicker($('add-script'), $('script-file'), loadScriptFile);
    bindFilePicker($('replace-script'), $('replacement-script-file'), loadScriptFile, {
        getTarget: () => selectedElement()?.kind === 'script' ? selectedId : null,
        canOpen: id => id !== null && !elementActionBusy(id)
    });
    $('script-play').addEventListener('click', () => controlScript('play'));
    $('script-pause').addEventListener('click', () => controlScript('pause'));
    $('script-reset').addEventListener('click', () => controlScript('reset'));
    $('script-speed').addEventListener('input', () => { $('script-speed-value').textContent = t('script.speedValue', { speed: $('script-speed').value }); });
    $('script-speed').addEventListener('change', () => controlScript('speed', Number($('script-speed').value)));
    $('alarm-at').addEventListener('input', () => { alarmFormDirty = true; });
    $('alarm-countdown').addEventListener('change', () => {
        const element = selectedElement();
        if (element?.kind === 'alarm') queuePatch(element.id, { showCountdown: $('alarm-countdown').value === 'true' });
    });
    $('schedule-alarm').addEventListener('click', scheduleAlarm);
    $('add-clock').addEventListener('click', () => addElement('clock'));
    $('add-text').addEventListener('click', () => addElement('text'));
    $('add-alarm').addEventListener('click', () => addElement('alarm'));
    bindFilePicker($('add-image'), $('image-file'), uploadImage);
    bindFilePicker($('replace-image'), $('replacement-image-file'), uploadImage, {
        getTarget: () => selectedElement()?.kind === 'image' ? selectedId : null,
        canOpen: id => id !== null && connected && !settingsBusy && !imageBusy
    });
    for (const [id, property] of Object.entries(fields)) {
        const input = $(id);
        const update = (event) => {
            if (!selectedId || event.isComposing) return;
            let value = input.value;
            if (input.type === 'number') {
                if (input.value === '' || !input.checkValidity()) { input.reportValidity(); return; }
                value = Number(value);
            }
            queuePatch(selectedId, { [property]: value });
        };
        input.addEventListener(input.tagName === 'TEXTAREA' || input.type === 'color' ? 'input' : 'change', update);
        if (input.tagName === 'TEXTAREA') input.addEventListener('compositionend', update);
        input.addEventListener('blur', () => setTimeout(renderProperties, 0));
    }
    $('delete-element').addEventListener('click', () => {
        deleteConfirmId = selectedId;
        renderDisplayControls();
        $('cancel-delete').focus();
    });
    $('cancel-delete').addEventListener('click', () => {
        deleteConfirmId = null;
        renderDisplayControls();
        $('delete-element').focus();
    });
    $('confirm-delete').addEventListener('click', async () => {
        const element = selectedElement();
        if (!element || element.id !== deleteConfirmId || displayActionBusy(element.id)) return;
        const id = element.id;
        displayBusy = true;
        renderDisplayControls();
        editSync.discard(id);
        try {
            await request(`/api/elements/${id}`, { method: 'DELETE' });
            await refreshBoard();
        } catch (error) { notify(error.message); }
        finally { displayBusy = false; deleteConfirmId = null; renderDisplayControls(); }
    });
    $('stage').addEventListener('pointerdown', (event) => {
        if (event.target === $('stage')) select(null);
    });
    $('copy-link').addEventListener('click', async () => {
        $('copy-link').disabled = true;
        try {
            const { url: viewerUrl } = await request('/api/viewer-url');
            const url = withLanguage(viewerUrl);
            try {
                await navigator.clipboard.writeText(url);
                notify(t('viewer.urlCopied'));
            } catch { window.prompt(t('viewer.copyPrompt'), url); }
        } catch (error) { notify(error.message); }
        finally { $('copy-link').disabled = false; }
    });
    window.addEventListener('beforeunload', (event) => {
        if (editSync.hasPending || editSync.sending || settingsBusy) { event.preventDefault(); event.returnValue = ''; }
    });
}

$('language').value = locale;
$('language').addEventListener('change', async (event) => {
    const select = event.currentTarget;
    select.disabled = true;
    try {
        await changeLanguage(select.value);
        document.title = t('page.title', { mode: t(viewer ? 'navigation.view' : 'navigation.edit') });
        if (viewer) document.querySelector('.preview-monitor').setAttribute('aria-label', t('monitor.viewerLabel'));
        clockFormatter = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
        alarmFormatter = new Intl.DateTimeFormat(locale, {
            month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
        });
        render();
    } catch { notify(t('errors.language')); }
    finally { select.value = locale; select.disabled = false; }
});

$('stop-alarm').addEventListener('click', clearAlarm);

function updateMirror() {
    $('flip-x').setAttribute('aria-pressed', String(flipX));
    $('flip-y').setAttribute('aria-pressed', String(flipY));
    try {
        localStorage.setItem('prompter.flipX', String(flipX));
        localStorage.setItem('prompter.flipY', String(flipY));
    } catch { /* Browser-local preference is optional. */ }
    resizeStage();
}
$('flip-x').addEventListener('click', () => { flipX = !flipX; updateMirror(); });
$('flip-y').addEventListener('click', () => { flipY = !flipY; updateMirror(); });
$('fullscreen').addEventListener('click', async () => {
    try { await $('stage-host').requestFullscreen(); }
    catch { notify(t('errors.fullscreen')); }
});
$('exit-fullscreen').addEventListener('click', () => document.exitFullscreen());
document.addEventListener('fullscreenchange', resizeStage);
new ResizeObserver(resizeStage).observe($('stage-host'));
if (!viewer) new ResizeObserver(resizeStage).observe($('program-host'));
setInterval(updateClocks, 250);
requestAnimationFrame(animateScripts);
updateMirror();
