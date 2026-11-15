import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

// Inspect the actual browser raster, not DOM line boxes. Chromium screenshots
// use non-interlaced, 8-bit RGB/RGBA PNGs; decode them without another dependency.
function inkMargins(png) {
    let width, height, channels;
    const chunks = [];
    for (let offset = 8; offset < png.length;) {
        const length = png.readUInt32BE(offset);
        const type = png.toString('ascii', offset + 4, offset + 8);
        const data = png.subarray(offset + 8, offset + 8 + length);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0); height = data.readUInt32BE(4);
            assert.equal(data[8], 8); assert.equal(data[12], 0);
            assert.ok([2, 6].includes(data[9]));
            channels = data[9] === 6 ? 4 : 3;
        }
        if (type === 'IDAT') chunks.push(data);
        offset += length + 12;
    }
    const encoded = inflateSync(Buffer.concat(chunks));
    const stride = width * channels;
    const pixels = Buffer.alloc(stride * height);
    const paeth = (a, b, c) => {
        const p = a + b - c;
        const da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
        return da <= db && da <= dc ? a : db <= dc ? b : c;
    };
    let input = 0, top = height, bottom = -1;
    for (let y = 0; y < height; y++) {
        const filter = encoded[input++];
        for (let x = 0; x < stride; x++) {
            const index = y * stride + x;
            const left = x >= channels ? pixels[index - channels] : 0;
            const up = y ? pixels[index - stride] : 0;
            const corner = y && x >= channels ? pixels[index - stride - channels] : 0;
            const predictor = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, corner)][filter];
            assert.notEqual(predictor, undefined);
            pixels[index] = (encoded[input++] + predictor) & 255;
        }
        for (let x = 0; x < width; x++) {
            const index = y * stride + x * channels;
            if (Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) > 100) {
                top = Math.min(top, y); bottom = y;
            }
        }
    }
    assert.ok(bottom >= top, 'No visible text in the screenshot');
    return { top, bottom: height - bottom - 1 };
}

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
    const fits = (page, id, stage) => page.locator(selector(id, stage)).evaluate(node => {
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

    await t.test('horizontal alignment and clock centering survive automatic and manual sizing', async () => {
        const originals = ['text', 'clock'].map(id => structuredClone(board.elements.find(element => element.id === id)));
        try {
            for (const id of ['text', 'clock'])
            for (const autoFit of [false, true])
            for (const align of ['left', 'center', 'right']) {
                await apply(id, { autoFit, align, fontSize: 28, width: id === 'text' ? 480 : 250, height: 200,
                    ...(id === 'text' ? { text: '中央に配置します\nEnglish 123' } : {}) });
                for (const [page, stage] of [[editor, 'stage'], [editor, 'program-stage'], [viewer, 'stage']]) {
                    const result = await page.locator(selector(id, stage)).evaluate(node => {
                        const frame = node.getBoundingClientRect();
                        const content = node.firstElementChild.getBoundingClientRect();
                        const scale = frame.height / parseFloat(node.style.height);
                        return { difference: Math.abs((content.top - frame.top) - (frame.bottom - content.bottom)) / scale,
                            align: getComputedStyle(node).textAlign };
                    });
                    if (id === 'clock') assert.ok(result.difference < 0.2, `${id} in ${stage}: unequal vertical margins`);
                    assert.equal(result.align, align);
                }
            }
            await apply('text', { text: '長い文章を切り抜いて表示します。'.repeat(100), width: 80, height: 48, autoFit: true });
            const clipped = await editor.locator(selector('text')).evaluate(node => {
                const content = node.firstElementChild;
                return { frameTop: node.getBoundingClientRect().top, textTop: content.firstElementChild.getBoundingClientRect().top,
                    overflows: content.scrollHeight > content.clientHeight, scrollTop: content.scrollTop };
            });
            assert.ok(clipped.overflows);
            assert.ok(Math.abs(clipped.frameTop - clipped.textTop) < 0.2, 'Clipped text lost its first lines');
            assert.equal(clipped.scrollTop, 0);
        } finally {
            for (const original of originals) await apply(original.id, original);
        }
    });

    await t.test('visible text pixels have equal top and bottom margins, including lowercase and descenders', async () => {
        const original = structuredClone(board.elements.find(element => element.id === 'text'));
        await editor.locator('#stage').click({ position: { x: 2, y: 2 } });
        try {
            for (const autoFit of [false, true])
            for (const text of ['test', 'gyp', 'Ágj', '日本語', 'test\n日本語', 'abc 🌟', '\ntest\n']) {
                await apply('text', { autoFit, text, x: 520, y: 140, width: 400, height: 300, fontSize: text.includes('\n') ? 64 : 120 });
                for (const [page, stage] of [[editor, 'stage'], [editor, 'program-stage'], [viewer, 'stage']]) {
                    const png = await page.locator(`${selector('text', stage)} .element-content`).screenshot();
                    const margins = inkMargins(png);
                    assert.ok(Math.abs(margins.top - margins.bottom) <= 2,
                        `${JSON.stringify(text)} (${autoFit ? 'auto' : 'manual'}) in ${stage}: visible margins ${JSON.stringify(margins)}`);
                    if (process.env.ILINTEA_AUTO_FIT_SCREENSHOT && autoFit && text === 'test' && page === viewer)
                        await writeFile(process.env.ILINTEA_AUTO_FIT_SCREENSHOT.replace(/\.png$/, '.glyph.png'), png);
                }
            }
        } finally { await apply('text', original); }
    });

    await t.test('alarms distribute top, middle and bottom gaps equally and center a lone timer', async () => {
        const original = structuredClone(board.elements.find(element => element.id === 'alarm'));
        const layouts = [
            { width: 800, height: 260, fontSize: 32, messages: ['残り時間', '残り時間\n複数行のメッセージ', ''], compact: false },
            { width: 500, height: 136, fontSize: 40, messages: ['gyp'], compact: true },
            { width: 500, height: 56, fontSize: 12, messages: ['gyp', ''], compact: true }
        ];
        try {
            for (const autoFit of [false, true])
            for (const { width, height, fontSize, messages, compact } of layouts)
            for (const message of messages) {
                await apply('alarm', { autoFit, width, height, fontSize, countdownText: message });
                for (const [page, stage] of [[editor, 'stage'], [editor, 'program-stage'], [viewer, 'stage']]) {
                    const gaps = await page.locator(selector('alarm', stage)).evaluate(node => {
                        const frame = node.getBoundingClientRect();
                        const style = getComputedStyle(node);
                        const scale = frame.height / parseFloat(node.style.height);
                        const timer = node.querySelector('.alarm-remaining').getBoundingClientRect();
                        const message = node.querySelector('.alarm-message');
                        const hasMessage = getComputedStyle(message).display !== 'none';
                        const last = hasMessage ? message.getBoundingClientRect() : timer;
                        const gaps = [timer.top - frame.top - parseFloat(style.borderTopWidth) * scale,
                            frame.bottom - parseFloat(style.borderBottomWidth) * scale - last.bottom];
                        if (hasMessage) gaps.push(last.top - timer.bottom);
                        return gaps.map(gap => gap / scale);
                    });
                    assert.equal(gaps.length, message ? 3 : 2);
                    if (!compact) assert.ok(Math.min(...gaps) >= 12 - 0.2, 'Expected space around alarm text in a tall frame');
                    assert.ok(Math.max(...gaps) - Math.min(...gaps) < 0.2, `Unequal alarm gaps: ${gaps}`);
                    assert.ok(await fits(page, 'alarm', stage), `Clipped alarm at height ${height} in ${stage}`);
                    if (!autoFit) assert.equal(await size(page, 'alarm', stage), fontSize);
                }
            }
        } finally { await apply('alarm', original); }
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
