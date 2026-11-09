import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fittedFontSize, alarmFitSample } from '../src/ILINTEA/wwwroot/auto-fit.js';

test('auto-fit finds the largest fitting integer, including above the manual limit', () => {
    for (const [maximum, limit, expected] of [[720, 351, 351], [200, 400, 200], [48, 12, 12], [80, 2, 12]]) {
        let measurements = 0;
        assert.equal(fittedFontSize(maximum, size => { measurements++; return size <= limit; }), expected);
        assert.ok(measurements <= Math.ceil(Math.log2(Math.max(1, maximum - 11))));
    }
});

test('tiny or empty measuring areas still have a finite minimum size', () => {
    for (const maximum of [0, 1, 11, 12]) {
        assert.equal(fittedFontSize(maximum, () => false), 12);
    }
});

test('alarm samples reserve the original hour digits across ticks and for late viewers', () => {
    const start = Date.parse('2026-11-09T00:00:00Z');
    const element = { alarmSchedule: { createdAt: new Date(start).toISOString(), at: new Date(start + 100 * 3600_000).toISOString() } };
    for (const remaining of ['100:00:00', '99:59:59', '00:00:01']) {
        assert.equal(alarmFitSample(element, { phase: 'counting', remaining }), '000:00:00');
    }
    assert.equal(alarmFitSample(element, { phase: 'inactive', remaining: '00:00:00' }), '000:00:00');
    assert.equal(alarmFitSample(element, { phase: 'finished', remaining: '00:00:00' }), '00:00:00');
});

test('alarm fitting handles missing schedules and does not truncate extended hour counters', () => {
    assert.equal(alarmFitSample({}, { phase: 'inactive', remaining: '00:00:00' }), '00:00:00');
    assert.equal(alarmFitSample({}, { phase: 'counting', remaining: '12345:00:00' }), '00000:00:00');
});
