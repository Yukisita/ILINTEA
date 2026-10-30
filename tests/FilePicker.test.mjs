import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindFilePicker } from '../src/ILINTEA/wwwroot/file-picker.js';

function control() {
    const listeners = new Map();
    return {
        files: [], value: '', clicks: 0,
        addEventListener(type, handler) { listeners.set(type, handler); },
        emit(type) { return listeners.get(type)?.(); },
        click() { this.clicks++; return this.emit('click'); }
    };
}

test('replacement retains the target selected before the picker opened', async () => {
    const button = control(), input = control(), calls = [];
    let selected = 'original';
    bindFilePicker(button, input, async (file, id) => calls.push({ file, id }), { getTarget: () => selected });
    button.click();
    selected = 'other';
    const file = { name: 'script.txt' };
    input.files = [file];
    input.value = file.name;
    await input.emit('change');
    assert.deepEqual(calls, [{ file, id: 'original' }]);
    assert.equal(input.value, '');
});

test('adding files uses no replacement target and allows choosing the same file again', async () => {
    const button = control(), input = control(), calls = [];
    const file = { name: 'image.png' };
    bindFilePicker(button, input, async (file, id) => calls.push({ file, id }));
    for (let attempt = 0; attempt < 2; attempt++) {
        button.click();
        input.files = [file];
        input.value = file.name;
        await input.emit('change');
        assert.equal(input.value, '');
    }
    assert.deepEqual(calls, [{ file, id: null }, { file, id: null }]);
});

test('blocked and canceled selections do not upload or retain an old target', async () => {
    const button = control(), input = control(), calls = [];
    let allowed = false;
    bindFilePicker(button, input, async (...args) => calls.push(args), { canOpen: () => allowed });
    button.click();
    assert.equal(input.clicks, 0);
    allowed = true;
    button.click();
    input.emit('cancel');
    input.files = [{ name: 'unused.txt' }];
    await input.emit('change');
    assert.deepEqual(calls, []);
    button.click();
    input.files = [];
    await input.emit('change');
    assert.deepEqual(calls, []);
});

test('a failed upload resets the input so the same file can be retried', async () => {
    const button = control(), input = control();
    bindFilePicker(button, input, async () => { throw new Error('upload failed'); });
    button.click();
    input.files = [{ name: 'settings.zip' }];
    input.value = 'settings.zip';
    await assert.rejects(input.emit('change'), /upload failed/);
    assert.equal(input.value, '');
});
