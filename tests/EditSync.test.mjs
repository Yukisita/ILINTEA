import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEditSync } from '../wwwroot/edit-sync.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

function setup(sendPatch, isConnected = () => true) {
    const errors = [];
    const sync = createEditSync({ sendPatch, isConnected, onChange() {}, onError: error => errors.push(error) });
    return { sync, errors };
}

test('merges edits before sending and keeps newer edits over an in-flight patch', async () => {
    const first = deferred();
    const calls = [];
    const { sync } = setup(async (id, patch) => {
        calls.push({ id, patch });
        if (calls.length === 1) await first.promise;
    });
    sync.queue('a', { text: 'first', x: 10 });
    sync.queue('a', { x: 20 });
    const flushing = sync.flush();
    sync.queue('a', { text: 'newer' });
    sync.queue('b', { y: 30 });
    await sync.flush();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { id: 'a', patch: { text: 'first', x: 20 } });
    assert.deepEqual(sync.patchFor('a'), { text: 'newer', x: 20 });
    first.resolve();
    await flushing;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.slice(1), [
        { id: 'a', patch: { text: 'newer' } }, { id: 'b', patch: { y: 30 } }
    ]);
    assert.equal(sync.hasPending, false);
    assert.equal(sync.sending, false);
    assert.equal(sync.hasChanges('a'), false);
});

test('reports a failed patch, discards its queued edits, and continues other elements', async () => {
    const first = deferred();
    const calls = [];
    const { sync, errors } = setup(async id => {
        calls.push(id);
        if (id === 'a') await first.promise;
    });
    sync.queue('a', { x: 10 });
    const flushing = sync.flush();
    sync.queue('a', { x: 20 });
    sync.queue('b', { y: 30 });
    const error = new Error('failed');
    first.reject(error);
    await flushing;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors, [error]);
    assert.deepEqual(calls, ['a', 'b']);
    assert.deepEqual(sync.patchFor('a'), {});
    assert.equal(sync.sending, false);
});

test('disconnect clears unsent edits while the in-flight request finishes', async () => {
    let connected = true;
    const first = deferred();
    const calls = [];
    const { sync } = setup(async id => { calls.push(id); await first.promise; }, () => connected);
    sync.queue('a', { x: 10 });
    const flushing = sync.flush();
    sync.queue('b', { y: 30 });
    connected = false;
    sync.clearPending();
    assert.equal(sync.hasPending, false);
    assert.equal(sync.hasChanges('a'), true);
    assert.equal(sync.hasChanges('b'), false);
    first.resolve();
    await flushing;
    connected = true;
    await sync.flush();
    assert.deepEqual(calls, ['a']);
    assert.equal(sync.hasChanges('a'), false);
});

test('does not send offline and discards removed elements before reconnecting', async () => {
    let connected = false;
    const calls = [];
    const { sync } = setup(async id => calls.push(id), () => connected);
    sync.queue('a', { x: 10 });
    sync.queue('b', { y: 30 });
    await sync.flush();
    assert.deepEqual(calls, []);
    sync.discard('a');
    connected = true;
    await sync.flush();
    assert.deepEqual(calls, ['b']);
    assert.deepEqual(sync.patchFor('a'), {});
});
