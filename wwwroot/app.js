const $ = (id) => document.getElementById(id);
const viewer = location.pathname.startsWith('/view');
document.body.classList.toggle('viewer', viewer);
if (viewer) document.querySelector('.preview-monitor').setAttribute('aria-label', '閲覧画面');
$(viewer ? 'view-tab' : 'edit-tab').classList.add('active');
$(viewer ? 'view-tab' : 'edit-tab').setAttribute('aria-current', 'page');
document.title = `${viewer ? '閲覧' : '編集'} - StreamPrompter`;

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
let displayBusy = false;
let deleteConfirmId = null;
const pending = new Map();
const inFlight = new Map();
const nodes = new Map();
const programNodes = new Map();
const scriptLimits = new Map();
const programScriptLimits = new Map();
const kinds = { text: 'テキスト', clock: '時計', image: '画像', script: 'TXT原稿', alarm: 'アラーム' };
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
        let message = '操作を反映できませんでした。もう一度お試しください。';
        try { message = (await response.json()).error || message; } catch { /* Non-JSON server error. */ }
        throw new Error(message);
    }
    return response.status === 204 ? null : response.json();
}

function effectiveElement(element) {
    const patch = { ...inFlight.get(element.id), ...pending.get(element.id) };
    const result = { ...element, ...patch };
    if (typeof patch.visible === 'boolean') result.displaySchedule = null;
    result.width = Math.max(80, Math.min(1280, result.width));
    result.height = Math.max(48, Math.min(720, result.height));
    result.x = Math.max(0, Math.min(1280 - result.width, result.x));
    result.y = Math.max(0, Math.min(720 - result.height, result.y));
    return result;
}

function selectedElement() {
    const element = state.elements.find((item) => item.id === selectedId);
    return element ? effectiveElement(element) : null;
}

function queuePatch(id, patch) {
    if (!connected || !state.elements.some((element) => element.id === id)) return;
    if (deleteConfirmId === id) deleteConfirmId = null;
    pending.set(id, { ...pending.get(id), ...patch });
    $('save-status').textContent = '反映中…';
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
        $('save-status').textContent = pending.size ? '反映中…' : '変更は自動で反映されます';
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
    if (element.kind === 'alarm' && !editable) node.setAttribute('role', 'alert');
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
        image.alt = '配置した画像';
        content.append(image);
    }
    node.append(content);
    if (editable) {
        const handle = document.createElement('button');
        handle.className = 'resize-handle';
        handle.title = 'ドラッグでサイズ変更';
        handle.setAttribute('aria-label', 'サイズ変更（数値でも設定できます）');
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
    node.dataset.previewState = displayIsWaiting(element) ? '予約中' : '非表示';
    node.style.left = `${element.x}px`;
    node.style.top = `${element.y}px`;
    node.style.width = `${element.width}px`;
    node.style.height = `${element.height}px`;
    node.style.fontSize = `${element.fontSize}px`;
    node.style.color = element.color;
    node.style.textAlign = element.align;
    node.classList.toggle('selected', editable && element.id === selectedId);
    if (element.kind === 'text') node.firstElementChild.textContent = element.text;
    if (element.kind === 'alarm' && node.firstElementChild.textContent !== element.text)
        node.firstElementChild.textContent = element.text;
    if (element.kind === 'script') {
        const script = node.firstElementChild.firstElementChild;
        if (script.textContent !== element.text) script.textContent = element.text;
        if (!node.hidden) limits.set(element.id, Math.max(0, script.scrollHeight - element.height));
    }
    if (editable) node.lastElementChild.hidden = element.id !== selectedId;
}

function render() {
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
    $('element-count').textContent = `${state.elements.length} / 20件`;
    const fragment = document.createDocumentFragment();
    for (const original of state.elements) {
        const element = effectiveElement(original);
        const row = document.createElement('div');
        row.className = `element-row${element.id === selectedId ? ' active' : ''}`;
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('aria-pressed', String(element.id === selectedId));
        const label = document.createElement('span');
        label.textContent = `${kinds[element.kind]}${['text', 'script', 'alarm'].includes(element.kind) ? ` · ${element.text.split('\n')[0] || '空欄'}` : ''}`;
        const visibility = document.createElement('small');
        visibility.textContent = displayIsWaiting(element) ? '予約中' : elementIsVisible(element) ? '表示' : '非表示';
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
    $('property-fields').disabled = !connected;
    $('selection-empty').hidden = !!element;
    $('property-title').textContent = element ? `${kinds[element.kind]}設定` : '要素の設定';
    if (!element) return;
    $('text-fields').hidden = !['text', 'script', 'alarm'].includes(element.kind);
    $('text-label').textContent = element.kind === 'alarm' ? '通知メッセージ' : 'テキスト内容';
    $('text').maxLength = element.kind === 'script' ? 50000 : 4000;
    $('script-fields').hidden = element.kind !== 'script';
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
    return element.visible && !displayIsWaiting(element);
}

function updateScheduledVisibility() {
    let changed = false;
    for (const original of state.elements) {
        const element = effectiveElement(original);
        const node = nodes.get(element.id);
        if (!node) continue;
        const offAir = !elementIsVisible(element);
        if (!viewer) {
            if (node.classList.contains('off-air') !== offAir) changed = true;
            node.classList.toggle('off-air', offAir);
            node.dataset.previewState = displayIsWaiting(element) ? '予約中' : '非表示';
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
    const visible = elementIsVisible(element);
    const alarm = element.kind === 'alarm';
    const busy = displayBusy || scriptBusy || !connected || pending.has(element.id) || inFlight.has(element.id);
    $('display-schedule-fields').hidden = alarm;
    $('alarm-settings').hidden = !alarm;
    $('alarm-at').disabled = busy || visible;
    $('schedule-alarm').disabled = busy || visible;
    $('schedule-alarm').textContent = waiting ? '通知予約を変更' : '通知を予約';
    if (alarm) {
        const alarmKey = `${element.id}/${element.displaySchedule?.id ?? ''}`;
        if (shownAlarmId !== alarmKey && !alarmFormDirty) {
            shownAlarmId = alarmKey;
            $('alarm-at').value = localDateTimeValue(element.displaySchedule
                ? new Date(element.displaySchedule.at) : new Date(Date.now() + serverOffset + 5 * 60_000));
        }
    }
    for (const id of ['display-delay', 'display-unit', 'schedule-display']) $(id).disabled = busy || visible;
    $('show-element').disabled = busy || visible;
    $('hide-element').disabled = busy || !visible;
    $('cancel-display').disabled = busy;
    $('delete-element').disabled = busy;
    $('confirm-delete').disabled = busy;
    $('delete-element').hidden = deleteConfirmId === element.id;
    $('delete-confirmation').hidden = deleteConfirmId !== element.id;
    $('cancel-display').hidden = !waiting;
    $('show-element').textContent = waiting ? '予約を解除して表示' : 'Programに表示';
    $('schedule-display').textContent = waiting ? '予約を変更' : '表示を予約';
    const status = `Program：${waiting ? '予約中' : visible ? '表示中' : '非表示'}`;
    if ($('display-state').textContent !== status) $('display-state').textContent = status;
    $('display-state').className = `display-state ${waiting ? 'waiting' : visible ? 'visible' : ''}`;
    $('display-status').textContent = alarm
        ? waiting ? `通知予約：${alarmFormatter.format(new Date(element.displaySchedule.at))}。解除後も非表示です。`
            : visible ? '通知中。再予約する場合は先に非表示にしてください。' : '指定時刻にProgramへ表示します。音は鳴りません。'
        : waiting
        ? `あと${Math.ceil((Date.parse(element.displaySchedule.at) - Date.now() - serverOffset) / 1000)}秒で表示。解除後も非表示です。`
        : visible ? '予約する場合は、先に非表示にしてください。' : '予約時刻までは非表示のままです。';
}

function setElementVisibility(visible) {
    const element = selectedElement();
    if (!element || !connected || displayBusy || scriptBusy || pending.has(element.id) || inFlight.has(element.id)) return;
    queuePatch(element.id, { visible });
    void flushPending();
}

async function scheduleDisplay(cancel = false) {
    const element = selectedElement();
    if (!element || !connected || displayBusy || scriptBusy || pending.has(element.id) || inFlight.has(element.id)) return;
    if (!cancel && elementIsVisible(element)) return;
    const seconds = Number($('display-delay').value) * Number($('display-unit').value);
    if (!cancel && (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400 || !$('display-delay').checkValidity())) {
        notify('表示までの時間は1秒～24時間で指定してください。');
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
    if (element?.kind !== 'alarm' || !connected || displayBusy || scriptBusy || pending.has(element.id) || inFlight.has(element.id) || elementIsVisible(element)) return;
    const date = new Date($('alarm-at').value);
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now() + serverOffset) {
        notify('通知日時は未来の日時を指定してください。');
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
        $('script-speed-value').textContent = `${element.playback.speed} px/秒`;
    }
    const status = waiting ? (running ? '表示予約待ち・表示時刻から再生します' : '表示予約待ち・再生を選ぶと表示時刻から開始します')
        : limit === 0 ? '原稿全体が表示枠に収まっています。'
        : ended ? '最後まで表示しました。「先頭へ」で戻せます。'
        : running ? '再生中・閲覧画面と同期しています' : '停止中';
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
    if (!connected || event.button !== 0 || gesture) return;
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
        width: clamp(element.width + dx, 80, 1280 - element.x),
        height: clamp(element.height + dy, 48, 720 - element.y)
    } : {
        x: clamp(element.x + dx, 0, 1280 - element.width),
        y: clamp(element.y + dy, 0, 720 - element.height)
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
    const scale = Math.max(.01, Math.min(availableWidth / 1280, fitHeight ? availableHeight / 720 : Infinity));
    $(viewportId).style.width = `${1280 * scale}px`;
    $(viewportId).style.height = `${720 * scale}px`;
    $(stageId).style.transform = `scale(${scale})`;
    $(viewportId).style.transform = viewer ? `scale(${flipX ? -1 : 1}, ${flipY ? -1 : 1})` : '';
    if (!output) stageScale = scale;
}

function resizeStage() {
    fitStage('stage-host', 'stage-viewport', 'stage');
    if (!viewer) fitStage('program-host', 'program-viewport', 'program-stage', true);
}

const clockFormatter = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const alarmFormatter = new Intl.DateTimeFormat('ja-JP', {
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
    const active = alarms.filter(elementIsVisible);
    const waiting = alarms.filter(displayIsWaiting);
    $('viewer-alarm-status').textContent = active.length ? `アラーム ${active.length}件・通知中`
        : waiting.length ? `アラーム ${waiting.length}件・予約中` : '出演者用';
    $('stop-alarm').hidden = active.length === 0;
    $('stop-alarm').textContent = active.length > 1 ? '通知をすべて止める' : '通知を止める';
    $('stop-alarm').disabled = !connected || alarmSaving;
}

async function clearAlarm() {
    if (!connected || alarmSaving) return;
    const alarms = state.elements.filter((element) => element.kind === 'alarm' && elementIsVisible(element));
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
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind })
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

function setConnection(value) {
    connected = value;
    $('connection').textContent = value ? '同期中' : '再接続中…';
    $('connection').className = `connection ${value ? 'connected' : 'disconnected'}`;
    for (const id of ['add-clock', 'add-text', 'add-image', 'add-script', 'add-alarm']) $(id).disabled = !value;
    $('property-fields').disabled = !value;
    renderAlarm();
}

const events = new EventSource('/api/events');
events.onopen = () => { state = { ...state, revision: -1 }; };
events.onmessage = (event) => {
    acceptState(JSON.parse(event.data));
    setConnection(true);
    if (!sending && !pending.size) $('save-status').textContent = '変更は自動で反映されます';
};
events.onerror = () => {
    setConnection(false);
    if (pending.size > 0) {
        pending.clear();
        notify('接続が切れました。未反映の変更は、再接続後にもう一度入力してください。');
        render();
    }
    $('save-status').textContent = '接続を確認しています…';
};

if (!viewer) {
    $('show-element').addEventListener('click', () => setElementVisibility(true));
    $('hide-element').addEventListener('click', () => setElementVisibility(false));
    $('schedule-display').addEventListener('click', () => scheduleDisplay());
    $('cancel-display').addEventListener('click', () => scheduleDisplay(true));
    $('display-unit').addEventListener('change', () => { $('display-delay').max = 86400 / Number($('display-unit').value); });
    $('add-script').addEventListener('click', () => $('script-file').click());
    $('script-file').addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        try {
            if (!/\.txt$/i.test(file.name) || file.size > 256 * 1024)
                throw new Error('256KB以下のTXTファイルを選んでください。');
            let text;
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
            catch { throw new Error('UTF-8で保存したTXTファイルを選んでください。'); }
            text = text.replace(/\r\n?/g, '\n');
            if (!text.trim() || text.length > 50000) throw new Error('原稿は1～50,000文字にしてください。');
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
    $('script-speed').addEventListener('input', () => { $('script-speed-value').textContent = `${$('script-speed').value} px/秒`; });
    $('script-speed').addEventListener('change', () => controlScript('speed', Number($('script-speed').value)));
    $('alarm-at').addEventListener('input', () => { alarmFormDirty = true; });
    $('schedule-alarm').addEventListener('click', scheduleAlarm);
    $('add-clock').addEventListener('click', () => addElement('clock'));
    $('add-text').addEventListener('click', () => addElement('text'));
    $('add-alarm').addEventListener('click', () => addElement('alarm'));
    $('add-image').addEventListener('click', () => $('image-file').click());
    $('image-file').addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) {
            notify('画像は2MB以下にしてください。');
            event.target.value = '';
            return;
        }
        const form = new FormData();
        form.append('file', file);
        try {
            const element = await request('/api/images', { method: 'POST', body: form });
            await refreshBoard();
            select(element.id);
        } catch (error) { notify(error.message); }
        event.target.value = '';
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
            const { url } = await request('/api/viewer-url');
            try {
                await navigator.clipboard.writeText(url);
                notify('閲覧URLをコピーしました。同じLAN内の端末で開いてください。');
            } catch { window.prompt('この閲覧URLをコピーして、別の端末で開いてください。', url); }
        } catch (error) { notify(error.message); }
        finally { $('copy-link').disabled = false; }
    });
    window.addEventListener('beforeunload', (event) => {
        if (pending.size || sending) { event.preventDefault(); event.returnValue = ''; }
    });
}

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
    catch { notify('このブラウザーでは全画面表示を開始できませんでした。'); }
});
$('exit-fullscreen').addEventListener('click', () => document.exitFullscreen());
document.addEventListener('fullscreenchange', resizeStage);
new ResizeObserver(resizeStage).observe($('stage-host'));
if (!viewer) new ResizeObserver(resizeStage).observe($('program-host'));
setInterval(updateClocks, 250);
requestAnimationFrame(animateScripts);
updateMirror();
