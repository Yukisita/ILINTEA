import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectBoardEvents } from '../wwwroot/board-connection.js';

function setup() {
    const page = new EventTarget();
    const sources = [];
    const received = [];
    let disconnects = 0;
    connectBoardEvents({
        onOpen: event => received.push({ type: 'open', event }),
        onMessage: event => received.push({ type: 'message', event }),
        onDisconnect: () => { disconnects++; }
    }, {
        page,
        createSource: () => {
            const source = { closed: false, close() { this.closed = true; } };
            sources.push(source);
            return source;
        }
    });
    return { page, sources, received, get disconnects() { return disconnects; } };
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
    previous.onerror();
    context.page.dispatchEvent(new Event('pageshow'));
    previous.onopen('stale open');
    previous.onmessage('stale snapshot');
    previous.onerror();
    assert.deepEqual(context.received, []);
    assert.equal(context.disconnects, 1);
});

test('network errors leave automatic EventSource reconnection intact', () => {
    const context = setup();
    const source = context.sources[0];
    source.onerror();
    assert.equal(context.disconnects, 1);
    assert.equal(source.closed, false);
    source.onopen('reconnected');
    source.onmessage('latest snapshot');
    assert.equal(context.sources.length, 1);
    assert.deepEqual(context.received, [
        { type: 'open', event: 'reconnected' }, { type: 'message', event: 'latest snapshot' }
    ]);
});

test('canceling navigation does not close the current connection', () => {
    const context = setup();
    context.page.addEventListener('beforeunload', event => event.preventDefault());
    const proceeding = context.page.dispatchEvent(new Event('beforeunload', { cancelable: true }));
    assert.equal(proceeding, false);
    assert.equal(context.sources[0].closed, false);
    assert.equal(context.disconnects, 0);
});
