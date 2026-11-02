import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { elementIsVisible } from '../src/ILINTEA/wwwroot/display-state.js';

// Exercise the registered browser handler without starting unrelated canvas and socket code.
const source = await readFile(new URL('../src/ILINTEA/wwwroot/app.js', import.meta.url), 'utf8');
const start = source.indexOf("    $('delete-element').addEventListener('click'");
const end = source.indexOf("    $('stage').addEventListener('pointerdown'", start);
assert.ok(start >= 0 && end > start, 'Deletion handler was not found');
const handlerSource = source.slice(start, end);
const messages = JSON.parse(await readFile(new URL('../src/ILINTEA/wwwroot/i18n/ja.json', import.meta.url), 'utf8'));
const now = Date.parse('2026-11-02T12:00:00Z');

function setup(element, { approve = true, failure, flush } = {}) {
    const calls = { confirmations: [], requests: [], notices: [], discarded: [], refreshes: 0 };
    let click;
    const context = {
        state: { elements: [element] }, selectedId: element.id, displayBusy: false,
        elementIsVisible: item => elementIsVisible(item, now),
        displayActionBusy: () => context.displayBusy,
        window: { confirm: message => { calls.confirmations.push(message); return approve; } },
        t: key => messages[key],
        $: id => ({ addEventListener: (event, listener) => {
            assert.equal(id, 'delete-element');
            assert.equal(event, 'click');
            click = listener;
        } }),
        renderDisplayControls() {},
        editSync: { discard: id => calls.discarded.push(id) },
        flushEdits: flush ?? (async () => true),
        request: async (path, options) => {
            calls.requests.push({ path, method: options.method });
            if (failure) throw failure;
            context.state.elements = context.state.elements.filter(item => path !== `/api/elements/${item.id}`);
        },
        refreshBoard: async () => { calls.refreshes++; },
        notify: message => calls.notices.push(message)
    };
    vm.runInNewContext(handlerSource, context);
    return { calls, context, click: () => click() };
}

for (const kind of ['text', 'clock', 'image', 'script', 'alarm']) {
    test(`${kind}: visible elements require the specified confirmation before deletion`, async () => {
        const { click, calls, context } = setup({ id: 'target', kind, visible: true });
        await click();
        assert.deepEqual(calls.confirmations, ['表示中の項目です。削除しますか？']);
        assert.deepEqual(calls.requests, [{ path: '/api/elements/target', method: 'DELETE' }]);
        assert.deepEqual(context.state.elements, []);
        assert.deepEqual(calls.notices, []);
        assert.equal(context.displayBusy, false);
    });

    for (const [label, visibility] of [
        ['hidden', { visible: false }],
        ['scheduled', { visible: true, displaySchedule: { at: new Date(now + 60_000).toISOString() } }]
    ]) {
        test(`${kind}: ${label} elements are deleted without confirmation or notification`, async () => {
            const { click, calls, context } = setup({ id: 'target', kind, ...visibility });
            await click();
            assert.deepEqual(calls.confirmations, []);
            assert.deepEqual(calls.notices, []);
            assert.deepEqual(context.state.elements, []);
            assert.equal(calls.requests.length, 1);
        });
    }
}

test('canceling confirmation retains the element and its pending edits', async () => {
    const element = { id: 'target', visible: true };
    const { click, calls, context } = setup(element, { approve: false });
    await click();
    assert.deepEqual(context.state.elements, [element]);
    assert.deepEqual(calls.requests, []);
    assert.deepEqual(calls.discarded, []);
    assert.deepEqual(calls.notices, []);
    assert.equal(context.displayBusy, false);
});

test('failed deletion displays the error, retains the element and permits retry', async () => {
    const element = { id: 'target', visible: false };
    const { click, calls, context } = setup(element, { failure: new Error('削除に失敗しました') });
    await click();
    assert.deepEqual(calls.notices, ['削除に失敗しました']);
    assert.deepEqual(context.state.elements, [element]);
    assert.equal(calls.refreshes, 0);
    assert.equal(context.displayBusy, false);
    await click();
    assert.equal(calls.requests.length, 2);
});

test('a double click sends only one deletion for the originally selected element', async () => {
    let finishEdits;
    const pendingEdits = new Promise(resolve => { finishEdits = resolve; });
    const { click, calls, context } = setup({ id: 'target', visible: false }, { flush: () => pendingEdits });
    const first = click();
    await click();
    context.state.elements.push({ id: 'other', visible: false });
    context.selectedId = 'other';
    finishEdits(true);
    await first;
    assert.deepEqual(calls.requests, [{ path: '/api/elements/target', method: 'DELETE' }]);
    assert.equal(context.state.elements[0].id, 'other');
    assert.equal(context.displayBusy, false);
});

test('an element that becomes visible while edits finish requires confirmation', async () => {
    let finishEdits;
    const pendingEdits = new Promise(resolve => { finishEdits = resolve; });
    const { click, calls, context } = setup({ id: 'target', visible: false }, {
        approve: false, flush: () => pendingEdits
    });
    const deletion = click();
    context.state.elements[0].visible = true;
    finishEdits(true);
    await deletion;
    assert.deepEqual(calls.confirmations, ['表示中の項目です。削除しますか？']);
    assert.deepEqual(calls.requests, []);
    assert.equal(context.state.elements.length, 1);
    assert.equal(context.displayBusy, false);
});

test('failed edit synchronization prevents deletion', async () => {
    const { click, calls, context } = setup({ id: 'target', visible: false }, { flush: async () => false });
    await click();
    assert.deepEqual(calls.requests, []);
    assert.equal(context.state.elements.length, 1);
    assert.equal(context.displayBusy, false);
});

test('Program state controls confirmation even when the preview has unsent visibility edits', async () => {
    const { click, calls, context } = setup({ id: 'target', visible: true }, { approve: false });
    context.selectedElement = () => ({ id: 'target', visible: false });
    await click();
    assert.equal(calls.confirmations.length, 1);
    assert.deepEqual(calls.requests, []);
});
