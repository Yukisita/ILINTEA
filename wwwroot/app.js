import { initializeI18n, changeLanguage, t, locale, hasTranslation, withLanguage } from '/i18n.js?v=20261010-language';

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
let sending = false;
let flushTimer;
let noticeTimer;
let alarmSaving = false;
let alarmFormDirty = false;
let shownAlarmId = null;
let scriptBusy = false;
let imageBusy = false;
let displayBusy = false;
let deleteConfirmId = null;
let canvasSaving = false;
const canvasWidth = () => state.canvas?.width ?? 1280;
const canvasHeight = () => state.canvas?.height ?? 720;
const pending = new Map();
const inFlight = new Map();
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
    const response = await fetch(path, options);
    if (!response.ok) {
        let message = t('errors.request');
        try {
            const problem = await response.json();
            message = problem.errorKey && hasTranslation(problem.errorKey) ? t(problem.errorKey) : problem.error || message;
        } catch { /* Non-JSON server error. */ }
        throw new Error(message);
    }
    return response.status === 204 ? null : response.json();
}

function effectiveElement(element) {
    const patch = { ...inFlight.get(element.id), ...pending.get(element.id) };
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

function queuePatch(id, patch) {
    if (!connected || canvasSaving || !state.elements.some((element) => element.id === id)) return;
    if (deleteConfirmId === id) deleteConfirmId = null;
    pending.set(id, { ...pending.get(id), ...patch });
    $('save-status').textContent = t('save.pending');
    render();
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushPending, 100);
}

// Send patches in order; newer edits stay visible while a previous request is being sent.
async function flushPending() {
    if (sending || pending.size === 0 || !connected) return;
    const [id, patch] = pending.entries().next().value;
    pending.delete(id);
    inFlight.set(id, patch);
    sending = true;
    try {
        await request(`/api/elements/${id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch)
        });
    } catch (error) {
        pending.delete(id);
        notify(error.message);
    } finally {
        inFlight.delete(id);
        sending = false;
        render();
        $('save-status').textContent = pending.size ? t('save.pending') : t('save.automatic');
        void flushPending();
    }
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

function renderElement(node, element, editable, limits) {
    const visible = elementIsVisible(element);
    node.hidden = !editable && !visible;
    node.classList.toggle('off-air', editable && !visible);
    node.dataset.previewState = displayIsWaiting(element) ? t('state.scheduled') : t('state.hidden');
    node.style.left = `${element.x}px`;
    node.style.top = `${element.y}px`;
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
    resizeStage();
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
                pending.delete(id);
            }
        }
    }
    for (const original of state.elements) {
        const element = effectiveElement(original);
        if (!nodes.has(element.id)) {
            const node = createElementNode(element, !viewer);
            nodes.set(element.id, node);
            $('stage').append(node);
        }
        renderElement(nodes.get(element.id), element, !viewer, scriptLimits);
        if (!viewer) {
            if (!programNodes.has(original.id)) {
                const node = createElementNode(original, false);
                programNodes.set(original.id, node);
                $('program-stage').append(node);
            }
            // Program uses the shared state, just like the viewer, rather than unsent edits.
            renderElement(programNodes.get(original.id), original, false, programScriptLimits);
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
    for (const original of state.elements) {
        const element = effectiveElement(original);
        const row = document.createElement('div');
        row.className = `element-row${element.id === selectedId ? ' active' : ''}`;
        const button = document.createElement('button');
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
        fragment.append(row);
    }
    $('element-list').replaceChildren(fragment);
}

function renderProperties() {
    const element = selectedElement();
    $('property-fields').hidden = !element;
    $('property-fields').disabled = !connected || canvasSaving;
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
    $('image-fields').hidden = element.kind !== 'image';
    $('replace-image').disabled = !connected || imageBusy;
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
    const busy = displayBusy || scriptBusy || !connected || pending.has(element.id) || inFlight.has(element.id);
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
    if (!element || !connected || displayBusy || scriptBusy || pending.has(element.id) || inFlight.has(element.id)) return;
    queuePatch(element.id, { visible: !elementIsVisible(element) });
    void flushPending();
}

async function scheduleDisplay(cancel = false) {
    const element = selectedElement();
    if (!element || !connected || displayBusy || scriptBusy || pending.has(element.id) || inFlight.has(element.id)) return;
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
        await request(cancel ? `${path}/${element.displaySchedule.id}` : path, cancel ? { method: 'DELETE' } : {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delaySeconds: seconds })
        });
        await refreshBoard();
    } catch (error) { notify(error.message); }
    finally { displayBusy = false; renderDisplayControls(); }
}

async function scheduleAlarm() {
    const element = selectedElement();
    if (element?.kind !== 'alarm' || !connected || displayBusy || scriptBusy || pending.has(element.id) || inFlight.has(element.id) || (element.visible && !displayIsWaiting(element))) return;
    const date = new Date($('alarm-at').value);
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now() + serverOffset) {
        notify(t('errors.alarmFuture'));
        return;
    }
    displayBusy = true;
    renderDisplayControls();
    try {
        await request(`/api/elements/${element.id}/alarm`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at: date.toISOString() })
        });
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
    const busy = !connected || scriptBusy || pending.has(element.id) || inFlight.has(element.id);
    const running = !!element.playback.startedAt;
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
    if (!connected || scriptBusy || element?.kind !== 'script') return;
    scriptBusy = true;
    renderScriptControls();
    try {
        await request(`/api/elements/${element.id}/playback`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, speed })
        });
        await refreshBoard();
    } catch (error) { notify(error.message); }
    finally { scriptBusy = false; renderScriptControls(); }
}

function startGesture(event) {
    if (!connected || canvasSaving || event.button !== 0 || gesture) return;
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
    if (!sending && performance.now() - (gesture.lastSent || 0) > 100) {
        gesture.lastSent = performance.now();
        void flushPending();
    }
}

function endGesture(event) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gesture = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    void flushPending();
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
            await request(element.displaySchedule
                ? `/api/elements/${element.id}/display-schedule/${element.displaySchedule.id}`
                : `/api/elements/${element.id}`, element.displaySchedule ? { method: 'DELETE' } : {
                    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visible: false })
                });
        }
        await refreshBoard();
    } catch (error) { notify(error.message); }
    finally { alarmSaving = false; renderAlarm(); }
}

async function addElement(kind) {
    try {
        const element = await request('/api/elements', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, ...(kind === 'alarm' ? { text: t('alarm.defaultMessage') } : {}) })
        });
        // The next event supplies the shared state; fetch also covers a delayed event connection.
        await refreshBoard();
        select(element.id);
    } catch (error) { notify(error.message); }
}

function acceptState(snapshot) {
    if (snapshot.revision < state.revision) return;
    state = snapshot;
    serverOffset = snapshot.serverTime - Date.now();
    render();
}

async function refreshBoard() { acceptState(await request('/api/board')); }

function renderCanvasControls() {
    $('aspect-ratio').value = state.canvas?.aspectRatio ?? '16:9';
    $('background-color').value = state.canvas?.backgroundColor ?? '#000000';
    for (const id of ['aspect-ratio', 'background-color'])
        $(id).disabled = !connected || canvasSaving || sending || pending.size > 0 || !!gesture;
}

async function updateCanvas(patch) {
    if (!connected || canvasSaving || sending || pending.size || gesture) return;
    canvasSaving = true;
    render();
    try {
        await request('/api/canvas', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch)
        });
        await refreshBoard();
    } catch (error) { notify(error.message); }
    finally { canvasSaving = false; render(); }
}

function setConnection(value) {
    connected = value;
    $('connection').textContent = value ? t('connection.connected') : t('connection.reconnecting');
    $('connection').className = `connection ${value ? 'connected' : 'disconnected'}`;
    for (const id of ['add-clock', 'add-text', 'add-image', 'add-script', 'add-alarm']) $(id).disabled = !value;
    $('add-image').disabled = !value || imageBusy;
    $('replace-image').disabled = !value || imageBusy;
    $('property-fields').disabled = !value || canvasSaving;
    if (!viewer) renderCanvasControls();
    renderAlarm();
}

const events = new EventSource('/api/events');
events.onopen = () => { state = { ...state, revision: -1 }; };
events.onmessage = (event) => {
    acceptState(JSON.parse(event.data));
    setConnection(true);
    if (!sending && !pending.size) $('save-status').textContent = t('save.automatic');
};
events.onerror = () => {
    setConnection(false);
    if (pending.size > 0) {
        pending.clear();
        notify(t('connection.lostChanges'));
        render();
    }
    $('save-status').textContent = t('connection.checking');
};

async function uploadImage(file, id = null) {
    if (!file || !connected || imageBusy) return;
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
        $('add-image').disabled = !connected;
        renderProperties();
    }
}

if (!viewer) {
    $('aspect-ratio').addEventListener('change', () => updateCanvas({ aspectRatio: $('aspect-ratio').value }));
    $('background-color').addEventListener('change', () => updateCanvas({ backgroundColor: $('background-color').value }));
    $('toggle-visibility').addEventListener('click', toggleElementVisibility);
    $('schedule-display').addEventListener('click', () => scheduleDisplay());
    $('cancel-display').addEventListener('click', () => scheduleDisplay(true));
    $('display-unit').addEventListener('change', () => { $('display-delay').max = 86400 / Number($('display-unit').value); });
    $('add-script').addEventListener('click', () => $('script-file').click());
    $('script-file').addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        try {
            if (!/\.txt$/i.test(file.name) || file.size > maxFileBytes)
                throw new Error(t('errors.scriptFile'));
            let text;
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
            catch { throw new Error(t('errors.scriptEncoding')); }
            text = text.replace(/\r\n?/g, '\n');
            if (!text.trim()) throw new Error(t('errors.scriptEmpty'));
            const element = await request('/api/elements', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'script', text })
            });
            await refreshBoard();
            select(element.id);
        } catch (error) { notify(error.message); }
        finally { event.target.value = ''; }
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
    $('add-image').addEventListener('click', () => $('image-file').click());
    $('image-file').addEventListener('change', async (event) => {
        const input = event.currentTarget;
        await uploadImage(input.files[0]);
        input.value = '';
    });
    let imageReplaceId = null;
    $('replace-image').addEventListener('click', () => {
        const element = selectedElement();
        if (element?.kind !== 'image' || !connected || imageBusy) return;
        imageReplaceId = element.id;
        $('replacement-image-file').click();
    });
    $('replacement-image-file').addEventListener('change', async (event) => {
        const input = event.currentTarget;
        const id = imageReplaceId;
        imageReplaceId = null;
        if (id) await uploadImage(input.files[0], id);
        input.value = '';
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
        if (!element || element.id !== deleteConfirmId || !connected || displayBusy || pending.has(element.id) || inFlight.has(element.id)) return;
        const id = element.id;
        displayBusy = true;
        renderDisplayControls();
        pending.delete(id);
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
        if (pending.size || sending) { event.preventDefault(); event.returnValue = ''; }
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
        $('connection').textContent = connected ? t('connection.connected') : t('connection.reconnecting');
        $('save-status').textContent = !connected ? t('connection.checking') : pending.size || sending ? t('save.pending') : t('save.automatic');
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
