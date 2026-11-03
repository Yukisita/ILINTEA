import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preventSamePageNavigation } from '../src/ILINTEA/wwwroot/navigation.js';

function setup(href, current = 'http://localhost:5280/', { target = '', download = false } = {}) {
    const link = Object.assign(new EventTarget(), {
        href, target, hasAttribute: name => name === 'download' && download
    });
    const location = { href: current };
    preventSamePageNavigation([link], location);
    function click(properties = {}) {
        const event = new Event('click', { cancelable: true });
        Object.assign(event, { button: 0, ...properties });
        link.dispatchEvent(event);
        return event.defaultPrevented;
    }
    return { link, location, click };
}

test('the app name on the editor does not reload the current document', () => {
    assert.equal(setup('http://localhost:5280/').click(), true);
});

test('the current mode tab is kept in place with either language', () => {
    for (const language of ['ja', 'en']) {
        const url = `http://localhost:5280/view/?lang=${language}`;
        assert.equal(setup(url, url).click(), true);
    }
});

test('the app name on the viewer and links to another mode still navigate', () => {
    assert.equal(setup('http://localhost:5280/', 'http://localhost:5280/view/').click(), false);
    assert.equal(setup('http://localhost:5280/view/').click(), false);
});

test('different language, fragment and external destinations still navigate', () => {
    for (const url of ['http://localhost:5280/?lang=en', 'http://localhost:5280/#settings', 'https://example.com/'])
        assert.equal(setup(url).click(), false);
});

test('modified and middle clicks keep their normal browser behavior', () => {
    for (const properties of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])
        assert.equal(setup('http://localhost:5280/').click(properties), false);
});

test('new windows and downloads are not intercepted', () => {
    assert.equal(setup('http://localhost:5280/', undefined, { target: '_blank' }).click(), false);
    assert.equal(setup('http://localhost:5280/', undefined, { download: true }).click(), false);
});

test('a language change uses the current link and address without rebinding', () => {
    const context = setup('http://localhost:5280/');
    context.link.href = 'http://localhost:5280/?lang=en';
    context.location.href = context.link.href;
    assert.equal(context.click(), true);
});
