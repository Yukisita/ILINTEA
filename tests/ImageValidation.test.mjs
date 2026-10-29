import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canDecodeImage } from '../wwwroot/image-validation.js';

function mockDecoder(t, { width = 16, height = 16, fail = false } = {}) {
    const calls = [];
    t.mock.method(URL, 'createObjectURL', file => { calls.push(['create', file]); return 'blob:test-image'; });
    t.mock.method(URL, 'revokeObjectURL', url => calls.push(['revoke', url]));
    const originalImage = globalThis.Image;
    t.after(() => {
        if (originalImage === undefined) delete globalThis.Image;
        else globalThis.Image = originalImage;
    });
    globalThis.Image = class {
        naturalWidth = width;
        naturalHeight = height;
        async decode() {
            calls.push(['decode', this.src]);
            if (fail) throw new Error('Invalid image data');
        }
        removeAttribute(name) { calls.push(['remove', name]); }
    };
    return calls;
}

test('valid images are decoded from their bytes and the temporary URL is released', async t => {
    const calls = mockDecoder(t);
    const file = new Blob(['test data'], { type: 'application/octet-stream' });
    assert.equal(await canDecodeImage(file), true);
    assert.deepEqual(calls, [['create', file], ['decode', 'blob:test-image'], ['remove', 'src'], ['revoke', 'blob:test-image']]);
});

test('decoder failures reject corrupt images and still release the temporary URL', async t => {
    const calls = mockDecoder(t, { fail: true });
    assert.equal(await canDecodeImage(new Blob(['PNG signature only'])), false);
    assert.deepEqual(calls.slice(1), [['decode', 'blob:test-image'], ['remove', 'src'], ['revoke', 'blob:test-image']]);
});

test('images with no decoded pixels are rejected', async t => {
    mockDecoder(t, { width: 0 });
    assert.equal(await canDecodeImage(new Blob()), false);
});
