import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClockFormatter } from '../wwwroot/clock-format.js';

const afternoon = new Date(2026, 9, 28, 21, 4, 5);

test('clocks support all four display combinations independently', () => {
    const format = createClockFormatter('en-US');
    for (const [clockHourFormat, clockShowSeconds, expected] of [
        [24, true, '21:04:05'], [24, false, '21:04'],
        [12, true, '09:04:05 PM'], [12, false, '09:04 PM']
    ]) {
        assert.equal(format({ clockHourFormat, clockShowSeconds }, afternoon), expected);
    }
    assert.equal(format({}, afternoon), '21:04:05');
    assert.equal(format({ clockHourFormat: 12, clockShowSeconds: false }, afternoon), '09:04 PM');
});

test('midnight and noon have the correct hour and day period', () => {
    const format = createClockFormatter('en-US');
    const twelve = { clockHourFormat: 12, clockShowSeconds: false };
    for (const [hour, expected12, expected24] of [
        [0, '12:04 AM', '00:04:05'], [12, '12:04 PM', '12:04:05']
    ]) {
        const time = new Date(2026, 9, 28, hour, 4, 5);
        assert.equal(format(twelve, time), expected12);
        assert.equal(format({}, time), expected24);
    }
});

test('day periods follow the selected display language', () => {
    const format = createClockFormatter('ja');
    assert.equal(format({ clockHourFormat: 12 }, afternoon), '午後09:04:05');
    assert.equal(format({ clockHourFormat: 12, clockShowSeconds: false }, afternoon), '午後09:04');
    assert.equal(format({}, afternoon), '21:04:05');
});
