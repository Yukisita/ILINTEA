import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectBoardEvents } from '../wwwroot/board-connection.js';

function setup(failures = 0) {
    const page = new EventTarget();
    const sources = [];
    const received = [];
    const timers = new Map();
    let timerId = 0;
    let disconnects = 0;
    connectBoardEvents({
        onOpen: event => received.push({ type: 'open', event }),
        onMessage: event => received.push({ type: 'message', event }),
        onDisconnect: () => { disconnects++; }
    }, {
        page,
        createSocket: () => {
            if (failures-- > 0) throw new Error('Connection unavailable');
            const source = { closed: false, close() { this.closed = true; } };
            sources.push(source);
            return source;
        },
        scheduleReconnect: callback => { timers.set(++timerId, callback); return timerId; },
        cancelReconnect: id => timers.delete(id)
    });
    return {
        page, sources, received,
        get disconnects() { return disconnects; },
        get retries() { return timers.size; },
        retry() {
            assert.equal(timers.size, 1);
            const [id, callback] = timers.entries().next().value;
            timers.delete(id);
            callback();
        }
    };
}

test('initial pageshow keeps the single connection and forwards its events', () => {
    const { page, sources, received } = setup();
    page.dispatchEvent(new Event('pageshow'));
    assert.equal(sources.length, 1);
    const open = new Event('open');
    const message = { data: '{"revision":1}' };
    sources[0].onopen(open);
    sources[0].onmessage(message);
    assert.deepEqual(received, [{ type: 'open', event: open }, { type: 'message', event: message }]);
});

test('leaving a page closes the connection even when the page is cached', () => {
    const context = setup();
    const hidden = new Event('pagehide');
    Object.defineProperty(hidden, 'persisted', { value: true });
    context.page.dispatchEvent(hidden);
    assert.equal(context.sources[0].closed, true);
    assert.equal(context.disconnects, 1);
    context.page.dispatchEvent(hidden);
    assert.equal(context.disconnects, 1);
});

test('restoring a cached page opens one fresh connection and accepts a fresh snapshot', () => {
    const { page, sources, received } = setup();
    page.dispatchEvent(new Event('pagehide'));
    page.dispatchEvent(new Event('pageshow'));
    page.dispatchEvent(new Event('pageshow'));
    assert.equal(sources.length, 2);
    assert.equal(sources[0].closed, true);
    assert.equal(sources[1].closed, false);
    const snapshot = { data: '{"revision":0}' };
    sources[1].onopen('restored');
    sources[1].onmessage(snapshot);
    assert.deepEqual(received, [{ type: 'open', event: 'restored' }, { type: 'message', event: snapshot }]);
});

test('repeated hide and show cycles never retain more than one open connection', () => {
    const { page, sources } = setup();
    for (let cycle = 0; cycle < 100; cycle++) {
        page.dispatchEvent(new Event('pagehide'));
        assert.equal(sources.filter(source => !source.closed).length, 0);
        page.dispatchEvent(new Event('pageshow'));
        assert.equal(sources.filter(source => !source.closed).length, 1);
    }
});

test('late events from a closed connection cannot change the restored page', () => {
    const context = setup();
    const previous = context.sources[0];
    context.page.dispatchEvent(new Event('pagehide'));
    previous.onopen('late open');
    previous.onmessage('late snapshot');
    previous.onclose();
    context.page.dispatchEvent(new Event('pageshow'));
    previous.onopen('stale open');
    previous.onmessage('stale snapshot');
    previous.onclose();
    assert.deepEqual(context.received, []);
    assert.equal(context.disconnects, 1);
});

test('a closed socket schedules one replacement and accepts a new server snapshot', () => {
    const context = setup();
    const source = context.sources[0];
    source.onclose();
    source.onclose();
    assert.equal(context.disconnects, 1);
    assert.equal(context.retries, 1);
    assert.equal(context.sources.length, 1);
    context.retry();
    assert.equal(context.sources.length, 2);
    context.sources[1].onopen('reconnected');
    context.sources[1].onmessage('latest snapshot');
    assert.deepEqual(context.received, [
        { type: 'open', event: 'reconnected' }, { type: 'message', event: 'latest snapshot' }
    ]);
});

test('leaving a page cancels a pending retry and restoring it connects immediately', () => {
    const context = setup();
    context.sources[0].onclose();
    assert.equal(context.retries, 1);
    context.page.dispatchEvent(new Event('pagehide'));
    assert.equal(context.retries, 0);
    context.page.dispatchEvent(new Event('pageshow'));
    assert.equal(context.sources.length, 2);
    assert.equal(context.retries, 0);
    context.sources[0].onclose();
    assert.equal(context.retries, 0);
});

test('a failed socket constructor is retried without leaving a stale connection', () => {
    const context = setup(1);
    assert.equal(context.disconnects, 1);
    assert.equal(context.sources.length, 0);
    assert.equal(context.retries, 1);
    context.retry();
    assert.equal(context.sources.length, 1);
    assert.equal(context.retries, 0);
    context.sources[0].onopen('connected');
    assert.deepEqual(context.received, [{ type: 'open', event: 'connected' }]);
});

test('socket URLs retain the server host and port and use the matching secure protocol', () => {
    const original = globalThis.WebSocket;
    const urls = [];
    globalThis.WebSocket = class {
        constructor(url) { urls.push(url); }
        close() {}
    };
    try {
        for (const href of ['http://192.168.10.10:5280/view/?lang=en', 'https://example.test:8443/', 'http://[::1]:5280/']) {
            const page = Object.assign(new EventTarget(), { location: { href } });
            connectBoardEvents({ onOpen() {}, onMessage() {}, onDisconnect() {} }, { page });
            page.dispatchEvent(new Event('pagehide'));
        }
        assert.deepEqual(urls, [
            'ws://192.168.10.10:5280/api/events',
            'wss://example.test:8443/api/events',
            'ws://[::1]:5280/api/events'
        ]);
    } finally {
        if (original === undefined) delete globalThis.WebSocket;
        else globalThis.WebSocket = original;
    }
});

test('canceling navigation does not close the current connection', () => {
    const context = setup();
    context.page.addEventListener('beforeunload', event => event.preventDefault());
    const proceeding = context.page.dispatchEvent(new Event('beforeunload', { cancelable: true }));
    assert.equal(proceeding, false);
    assert.equal(context.sources[0].closed, false);
    assert.equal(context.disconnects, 0);
});
