import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Optional real-layout checks: install Playwright, or point ILINTEA_PLAYWRIGHT_PATH
// at an existing installation. ILINTEA_BROWSER_PATH can select a local browser.
let chromium;
try { ({ chromium } = createRequire(import.meta.url)(process.env.ILINTEA_PLAYWRIGHT_PATH || 'playwright')); }
catch { /* The dependency-free unit tests still run without a browser. */ }

test('auto-fit in Preview, Program and the viewer', { skip: !chromium, timeout: 90_000 }, async t => {
    const root = fileURLToPath(new URL('../src/ILINTEA/wwwroot/', import.meta.url));
    const server = createServer(async (request, response) => {
        try {
            const pathname = new URL(request.url, 'http://localhost').pathname;
            const file = path.resolve(root, `.${pathname === '/' || pathname === '/view' ? '/index.html' : pathname}`);
            if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
            const data = await readFile(file);
            response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.html': 'text/html' })[path.extname(file)] || 'application/octet-stream');
            response.end(data);
        } catch { response.writeHead(404).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const browser = await chromium.launch({ headless: true, ...(process.env.ILINTEA_BROWSER_PATH ? { executablePath: process.env.ILINTEA_BROWSER_PATH } : {}) });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    context.setDefaultTimeout(8000);
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const now = Date.now();
    const base = { x: 80, y: 120, width: 400, height: 160, fontSize: 56, color: '#ffffff', align: 'left', visible: true, autoFit: true };
    const board = { revision: 0, canvas: { width: 1280, height: 720, aspectRatio: '16:9', backgroundColor: '#000000' }, elements: [
        { ...base, id: 'text', kind: 'text', text: '日本語の文字サイズ\nEnglish 123' },
        { ...base, id: 'clock', kind: 'clock', x: 880, y: 24, width: 368, height: 88, align: 'right', clockHourFormat: 24, clockShowSeconds: true },
        { ...base, id: 'alarm', kind: 'alarm', x: 80, y: 520, width: 960, height: 160, color: '#332701', text: '終了後に表示する長いメッセージです。\n次の進行へ移ってください。', countdownText: '残り時間',
            alarmSchedule: { id: 'schedule', createdAt: new Date(now - 2000).toISOString(), at: new Date(now + 100 * 3600_000 - 1000).toISOString() } },
        { ...base, id: 'script', kind: 'script', y: 300, text: 'スクロールする原稿\n文字サイズは手動指定', autoFit: false, fontSize: 48, playback: { speed: 30, offset: 0, startedAt: null } }
    ] };
    const sockets = new Set();
    const snapshot = () => JSON.stringify({ ...board, serverTime: Date.now() });
    const emit = () => { for (const socket of sockets) socket.send(snapshot()); };
    const patch = (id, changes) => {
        Object.assign(board.elements.find(element => element.id === id), changes);
        board.revision++;
        emit();
    };
    await context.routeWebSocket('**/api/events', socket => {
        sockets.add(socket);
        socket.onClose(() => sockets.delete(socket));
        socket.send(snapshot());
    });
    await context.addInitScript(() => {
        const NativeSocket = window.WebSocket;
        window.WebSocket = class extends NativeSocket {
            constructor(...args) {
                super(...args);
                this.addEventListener('message', event => { window.receivedBoardRevision = JSON.parse(event.data).revision; });
            }
        };
    });
    await context.route('**/api/**', async route => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        let json;
        if (pathname === '/api/board') json = JSON.parse(snapshot());
        else if (pathname === '/api/app-info') json = { version: 'test' };
        else if (request.method() === 'PATCH') {
            const id = pathname.split('/').at(-1);
            patch(id, request.postDataJSON());
            json = board.elements.find(element => element.id === id);
        } else throw new Error(`Unexpected request: ${request.method()} ${pathname}`);
        await route.fulfill({ json });
    });
    const editor = await context.newPage();
    await editor.goto(origin);
    await editor.waitForSelector('#stage .element.auto-fit');
    const viewer = await context.newPage();
    await viewer.goto(`${origin}/view`);
    await viewer.waitForSelector('#stage .element.auto-fit');
    const selector = (id, stage = 'stage') => `#${stage} .element[data-id="${id}"]`;
    const apply = async (id, changes) => {
        patch(id, changes);
        await Promise.all([editor, viewer].map(page => page.waitForFunction(revision => window.receivedBoardRevision >= revision, board.revision)));
    };
    const size = (page, id, stage) => page.locator(selector(id, stage)).evaluate(node => parseFloat(node.style.fontSize));
    const waitSize = (page, id, expected, stage = 'stage') => page.waitForFunction(({ selector, expected }) => parseFloat(document.querySelector(selector)?.style.fontSize) === expected, { selector: selector(id, stage), expected });
    const fits = (page, id) => page.locator(selector(id)).evaluate(node => {
        const content = node.firstElementChild;
        const targets = [content, ...content.children];
        // Compact timer lines allow visible glyph overflow into the gap. Check
        // the enclosing viewport and message, which actually clip their contents.
        return targets.filter(target => getComputedStyle(target).overflow === 'hidden')
            .every(target => target.scrollWidth <= target.clientWidth && target.scrollHeight <= target.clientHeight);
    });

    await t.test('Japanese multiline text fits and matches across all three surfaces', async () => {
        const expected = await size(editor, 'text');
        assert.ok(expected >= 12);
        await waitSize(editor, 'text', expected, 'program-stage');
        await waitSize(viewer, 'text', expected);
        assert.ok(await fits(editor, 'text'));
        // One more pixel must overflow, proving that we did not merely choose a small font.
        assert.equal(await editor.locator(selector('text')).evaluate(node => {
            const original = node.style.fontSize;
            node.style.fontSize = `${parseFloat(original) + 1}px`;
            const content = node.firstElementChild;
            const overflow = content.scrollHeight > content.clientHeight || content.scrollWidth > content.clientWidth;
            node.style.fontSize = original;
            return overflow;
        }), true);
    });

    await t.test('the checkbox disables manual input and restores the previous manual value', async () => {
        await editor.locator(selector('text')).click();
        assert.equal(await editor.locator('#auto-fit').isChecked(), true);
        assert.equal(await editor.locator('#font-size').isDisabled(), true);
        await editor.locator('#auto-fit').uncheck();
        await waitSize(editor, 'text', 56);
        assert.equal(await editor.locator('#font-size').isDisabled(), false);
        await editor.locator('#font-size').fill('93');
        await editor.locator('#font-size').dispatchEvent('change');
        await waitSize(editor, 'text', 93);
        await editor.locator('#auto-fit').check();
        await editor.locator('#auto-fit').uncheck();
        await waitSize(editor, 'text', 93);
        assert.equal(await editor.locator('#font-size').inputValue(), '93');
        await editor.locator('#auto-fit').check();
    });

    await t.test('text edits, large frames and the minimum clipping size are handled', async () => {
        await apply('text', { text: 'あ', width: 1000, height: 400, align: 'center' });
        await editor.waitForFunction(selector => parseFloat(document.querySelector(selector).style.fontSize) > 160, selector('text'));
        assert.ok(await fits(editor, 'text'));
        await apply('text', { text: '長い文章LongText'.repeat(150), width: 80, height: 48 });
        await waitSize(editor, 'text', 12);
        assert.equal(await fits(editor, 'text'), false);
        assert.equal(await editor.locator(`${selector('text')} .element-content`).evaluate(node => getComputedStyle(node).overflow), 'hidden');
        await apply('text', { text: '', width: 400, height: 160 });
        await waitSize(editor, 'text', 12);
        await apply('text', { text: ' \n\t\n ' });
        await editor.waitForFunction(selector => Number.isFinite(parseFloat(document.querySelector(selector).style.fontSize)), selector('text'));
        await apply('text', { text: 'ドラッグで枠を変更\nEnglish 123', width: 400, height: 160, align: 'left' });
        await editor.waitForFunction(selector => parseFloat(document.querySelector(selector).style.fontSize) > 12, selector('text'));
    });

    await t.test('clock and alarm auto-fit switches remain independent of the text setting', async () => {
        for (const id of ['clock', 'alarm']) {
            await editor.locator(selector(id)).click();
            assert.equal(await editor.locator('#auto-fit').isChecked(), true);
            await editor.locator('#auto-fit').uncheck();
            await waitSize(editor, id, 56);
            assert.equal(await editor.locator('#font-size').isDisabled(), false);
            await editor.locator('#auto-fit').check();
        }
        assert.equal(board.elements.find(element => element.id === 'text').autoFit, true);
    });

    await t.test('resizing updates the fitted size during the drag without moving the element', async () => {
        await editor.locator(selector('text')).click();
        const before = await size(editor, 'text');
        const box = await editor.locator(`${selector('text')} .resize-handle`).boundingBox();
        const position = board.elements.find(element => element.id === 'text');
        const original = { x: position.x, y: position.y };
        await editor.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await editor.mouse.down();
        try {
            await editor.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 45, { steps: 4 });
            assert.ok(await size(editor, 'text') > before);
        } finally { await editor.mouse.up(); }
        await editor.waitForFunction(({ selector, before }) => parseFloat(document.querySelector(selector).style.fontSize) > before, { selector: selector('text', 'program-stage'), before });
        assert.equal(position.x, original.x);
        assert.equal(position.y, original.y);
    });

    await t.test('clock formats and languages fit without changing size on ticks', async () => {
        for (const language of ['ja', 'en']) {
            for (const page of [editor, viewer]) {
                await page.locator('#open-settings').click();
                await page.locator('#language').selectOption(language);
                await page.waitForFunction(language => document.documentElement.lang === language && !document.getElementById('language').disabled, language);
                await page.locator('.settings-close').click();
            }
            for (const clockHourFormat of [12, 24])
            for (const clockShowSeconds of [true, false]) {
                await apply('clock', { clockHourFormat, clockShowSeconds });
                await editor.waitForFunction(({ selector, withSeconds, hourFormat }) => {
                    const text = document.querySelector(selector).firstElementChild.textContent;
                    return (text.match(/:/g) || []).length === (withSeconds ? 2 : 1)
                        && /AM|PM|午前|午後/.test(text) === (hourFormat === 12);
                }, { selector: selector('clock'), withSeconds: clockShowSeconds, hourFormat: clockHourFormat });
                const expected = await size(editor, 'clock');
                await waitSize(editor, 'clock', expected, 'program-stage');
                await waitSize(viewer, 'clock', expected);
                assert.ok(await fits(editor, 'clock'));
                assert.ok(await editor.locator(selector('clock')).evaluate(async (node, element) => {
                    const { clockFitSamples } = await import('/clock-format.js?v=20261109-auto-fit');
                    const content = node.firstElementChild;
                    const original = content.textContent;
                    try {
                        return clockFitSamples(element, document.documentElement.lang).every(text => {
                            content.textContent = text;
                            return content.scrollWidth <= content.clientWidth && content.scrollHeight <= content.clientHeight;
                        });
                    } finally { content.textContent = original; }
                }, { clockHourFormat, clockShowSeconds }));
                if (clockShowSeconds) {
                    const before = await editor.locator(`${selector('clock')} .element-content`).textContent();
                    await editor.waitForFunction(({ selector, before }) => document.querySelector(selector).firstElementChild.textContent !== before, { selector: selector('clock'), before });
                    assert.equal(await size(editor, 'clock'), expected);
                }
            }
        }
    });

    await t.test('alarms retain a shared size during countdowns and recalculate on edits and completion', async () => {
        const before = await size(editor, 'alarm');
        assert.ok(await fits(editor, 'alarm'));
        await waitSize(viewer, 'alarm', before);
        const tick = await editor.locator(`${selector('alarm')} .alarm-remaining`).textContent();
        await editor.waitForFunction(({ selector, tick }) => document.querySelector(selector).textContent !== tick, { selector: `${selector('alarm')} .alarm-remaining`, tick });
        assert.equal(await size(editor, 'alarm'), before);
        const lateViewer = await context.newPage();
        await lateViewer.goto(`${origin}/view?lang=en`);
        await waitSize(lateViewer, 'alarm', before);
        await lateViewer.close();
        await apply('alarm', { countdownText: 'カウントダウン中でもメッセージの編集に追従します。\n'.repeat(4) });
        await editor.waitForFunction(({ selector, before }) => parseFloat(document.querySelector(selector).style.fontSize) < before, { selector: selector('alarm'), before });
        assert.ok(await fits(editor, 'alarm'));
        await apply('alarm', { alarmSchedule: { id: 'finished', createdAt: new Date(now - 2000).toISOString(), at: new Date(now - 1000).toISOString() } });
        await editor.waitForSelector(`${selector('alarm')}[data-alarm-phase="finished"]`);
        const finished = await size(editor, 'alarm');
        assert.ok(await fits(editor, 'alarm'));
        await waitSize(editor, 'alarm', finished, 'program-stage');
        await waitSize(viewer, 'alarm', finished);
    });

    await t.test('hidden elements are already fitted when shown and scripts keep manual sizing', async () => {
        await apply('text', { visible: false, text: '非表示中にも調整されます', width: 500, height: 200 });
        await viewer.waitForSelector(selector('text'), { state: 'hidden' });
        const expected = await size(editor, 'text');
        await waitSize(viewer, 'text', expected);
        await apply('text', { visible: true });
        await viewer.waitForSelector(selector('text'));
        assert.ok(await fits(viewer, 'text'));
        await editor.locator(selector('script')).click();
        assert.equal(await editor.locator('#auto-fit-field').isHidden(), true);
        assert.equal(await editor.locator('#font-size').isDisabled(), false);
        assert.equal(await size(editor, 'script'), 48);
    });
    await editor.locator(selector('text')).click();
    if (process.env.ILINTEA_AUTO_FIT_SCREENSHOT) await editor.screenshot({ path: process.env.ILINTEA_AUTO_FIT_SCREENSHOT });
    assert.deepEqual(errors, []);
});
