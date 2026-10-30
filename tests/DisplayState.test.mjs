import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayIsWaiting, elementIsVisible } from '../src/ILINTEA/wwwroot/display-state.js';

const start = Date.parse('2026-10-17T12:00:00Z');
for (const kind of ['text', 'clock', 'image', 'script', 'alarm']) {
    test(`${kind} stays hidden until its scheduled time and supports immediate display and cancellation`, () => {
        const scheduled = { kind, visible: true, displaySchedule: { at: new Date(start).toISOString() } };
        assert.equal(displayIsWaiting(scheduled, start - 1), true);
        assert.equal(elementIsVisible(scheduled, start - 1), false);
        for (const now of [start, start + 1]) {
            assert.equal(displayIsWaiting(scheduled, now), false);
            assert.equal(elementIsVisible(scheduled, now), true);
        }
        assert.equal(elementIsVisible({ ...scheduled, displaySchedule: null }, start - 1), true);
        for (const now of [start - 1, start, start + 1]) {
            const hidden = { ...scheduled, visible: false };
            assert.equal(displayIsWaiting(hidden, now), false);
            assert.equal(elementIsVisible(hidden, now), false);
        }
    });
}
