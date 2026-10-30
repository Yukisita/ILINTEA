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
    const waiting = sync.flush();
    assert.equal(waiting, flushing);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { id: 'a', patch: { text: 'first', x: 20 } });
    assert.deepEqual(sync.patchFor('a'), { text: 'newer', x: 20 });
    first.resolve();
    assert.equal(await waiting, true);
    assert.deepEqual(calls.slice(1), [
        { id: 'a', patch: { text: 'newer' } }, { id: 'b', patch: { y: 30 } }
    ]);
    assert.equal(sync.hasPending, false);
    assert.equal(sync.sending, false);
    assert.deepEqual(sync.patchFor('a'), {});
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
    assert.equal(await flushing, false);
    assert.deepEqual(errors, [error]);
    assert.deepEqual(calls, ['a', 'b']);
    assert.deepEqual(sync.patchFor('a'), {});
    assert.equal(sync.sending, false);
});

test('a command waits for in-flight and newer edits to finish before it runs', async () => {
    const first = deferred();
    const second = deferred();
    const calls = [];
    const { sync } = setup(async (id, patch) => {
        calls.push({ id, patch });
        await (calls.length === 1 ? first.promise : second.promise);
    });
    sync.queue('script', { text: 'first' });
    const flushing = sync.flush();
    sync.queue('script', { text: 'latest' });
    let commandRan = false;
    const command = sync.flush().then(success => { commandRan = success; });
    first.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(commandRan, false);
    assert.deepEqual(calls, [
        { id: 'script', patch: { text: 'first' } },
        { id: 'script', patch: { text: 'latest' } }
    ]);
    second.resolve();
    await command;
    assert.equal(await flushing, true);
    assert.equal(commandRan, true);
});

test('a visibility change during text input shares the serialized edit queue', async () => {
    const first = deferred();
    const calls = [];
    const { sync } = setup(async (id, patch) => {
        calls.push({ id, patch });
        if (calls.length === 1) await first.promise;
    });
    sync.queue('text', { text: 'first' });
    const flushing = sync.flush();
    sync.queue('text', { text: 'latest' });
    sync.queue('text', { visible: true });
    assert.deepEqual(sync.patchFor('text'), { text: 'latest', visible: true });
    first.resolve();
    assert.equal(await flushing, true);
    assert.deepEqual(calls, [
        { id: 'text', patch: { text: 'first' } },
        { id: 'text', patch: { text: 'latest', visible: true } }
    ]);
});

test('failed edits prevent a waiting command from running', async () => {
    const failure = deferred();
    const { sync } = setup(async () => failure.promise);
    sync.queue('script', { text: 'unsaved' });
    let commandRan = false;
    const command = sync.flush().then(success => { if (success) commandRan = true; });
    failure.reject(new Error('save failed'));
    await command;
    assert.equal(commandRan, false);
    assert.equal(sync.sending, false);
});

test('going offline prevents a waiting command from running even if pending edits are cleared', async () => {
    let connected = true;
    const first = deferred();
    const { sync } = setup(async () => first.promise, () => connected);
    sync.queue('script', { text: 'first' });
    const flushing = sync.flush();
    sync.queue('script', { text: 'unsaved' });
    connected = false;
    sync.clearPending();
    first.resolve();
    assert.equal(await flushing, false);
    assert.equal(await sync.flush(), false);
    connected = true;
    assert.equal(await sync.flush(), true);
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
    assert.deepEqual(sync.patchFor('a'), { x: 10 });
    assert.deepEqual(sync.patchFor('b'), {});
    first.resolve();
    await flushing;
    connected = true;
    await sync.flush();
    assert.deepEqual(calls, ['a']);
    assert.deepEqual(sync.patchFor('a'), {});
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
