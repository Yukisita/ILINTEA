const $ = (id) => document.getElementById(id);
const viewer = location.pathname.startsWith('/view');
document.body.classList.toggle('viewer', viewer);
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
const pending = new Map();
const inFlight = new Map();
const nodes = new Map();
const kinds = { text: 'テキスト', clock: '時計', image: '画像' };
const fields = { text: 'text', 'font-size': 'fontSize', color: 'color', align: 'align', x: 'x', y: 'y', width: 'width', height: 'height', visible: 'visible' };
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
    const result = { ...element, ...inFlight.get(element.id), ...pending.get(element.id) };
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
    if (id !== selectedId && $('property-fields').contains(document.activeElement)) document.activeElement.blur();
    selectedId = id;
    render();
}

function render() {
    const liveIds = new Set(state.elements.map((element) => element.id));
    if (selectedId && !liveIds.has(selectedId)) selectedId = null;
    for (const [id, node] of nodes) {
        if (!liveIds.has(id)) {
            node.remove();
            nodes.delete(id);
            pending.delete(id);
        }
    }
    for (const original of state.elements) {
        const element = effectiveElement(original);
        let node = nodes.get(element.id);
        if (!node) {
            node = document.createElement('div');
            node.className = `element element-${element.kind}`;
            node.dataset.id = element.id;
            const content = document.createElement('div');
            content.className = 'element-content';
            if (element.kind === 'image') {
                const image = document.createElement('img');
                image.src = element.imageUrl;
                image.alt = '配置した画像';
                content.append(image);
            }
            node.append(content);
            if (!viewer) {
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
            nodes.set(element.id, node);
            $('stage').append(node);
        }
        node.hidden = !element.visible;
        node.style.left = `${element.x}px`;
        node.style.top = `${element.y}px`;
        node.style.width = `${element.width}px`;
        node.style.height = `${element.height}px`;
        node.style.fontSize = `${element.fontSize}px`;
        node.style.color = element.color;
        node.style.textAlign = element.align;
        node.classList.toggle('selected', element.id === selectedId);
        if (element.kind === 'text') node.firstElementChild.textContent = element.text;
        if (!viewer) node.lastElementChild.hidden = element.id !== selectedId;
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
        label.textContent = `${kinds[element.kind]}${element.kind === 'text' ? ` · ${element.text.split('\n')[0] || '空欄'}` : ''}`;
        const visibility = document.createElement('small');
        visibility.textContent = element.visible ? '表示' : '非表示';
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
    $('text-fields').hidden = element.kind !== 'text';
    $('type-fields').hidden = element.kind === 'image';
    for (const [id, property] of Object.entries(fields)) {
        const input = $(id);
        if (document.activeElement === input) continue;
        if (input.type === 'checkbox') input.checked = element[property];
        else input.value = element[property];
    }
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

function resizeStage() {
    const host = $('stage-host');
    const style = getComputedStyle(host);
    const availableWidth = host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const availableHeight = host.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    stageScale = Math.max(.01, Math.min(availableWidth / 1280, viewer || document.fullscreenElement ? availableHeight / 720 : Infinity));
    $('stage-viewport').style.width = `${1280 * stageScale}px`;
    $('stage-viewport').style.height = `${720 * stageScale}px`;
    $('stage').style.transform = `scale(${stageScale})`;
    $('stage-viewport').style.transform = viewer ? `scale(${flipX ? -1 : 1}, ${flipY ? -1 : 1})` : '';
}

const clockFormatter = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function updateClocks() {
    const time = clockFormatter.format(new Date(Date.now() + serverOffset));
    for (const element of state.elements) {
        if (element.kind === 'clock') nodes.get(element.id).firstElementChild.textContent = time;
    }
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
    for (const id of ['add-clock', 'add-text', 'add-image']) $(id).disabled = !value;
    $('property-fields').disabled = !value;
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
    $('add-clock').addEventListener('click', () => addElement('clock'));
    $('add-text').addEventListener('click', () => addElement('text'));
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
            let value = input.type === 'checkbox' ? input.checked : input.value;
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
    $('delete-element').addEventListener('click', async () => {
        if (!selectedId) return;
        const id = selectedId;
        pending.delete(id);
        try {
            await request(`/api/elements/${id}`, { method: 'DELETE' });
            await refreshBoard();
        } catch (error) { notify(error.message); }
    });
    $('stage').addEventListener('pointerdown', (event) => {
        if (event.target === $('stage')) select(null);
    });
    $('copy-link').addEventListener('click', async () => {
        const url = new URL('/view/', location.origin).href;
        try {
            await navigator.clipboard.writeText(url);
            notify('閲覧URLをコピーしました。別のブラウザーや端末で開いてください。');
        } catch { window.prompt('この閲覧URLをコピーしてください。', url); }
    });
    window.addEventListener('beforeunload', (event) => {
        if (pending.size || sending) { event.preventDefault(); event.returnValue = ''; }
    });
}

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
setInterval(updateClocks, 250);
updateMirror();
