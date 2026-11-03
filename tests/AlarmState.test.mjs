import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAlarmState } from '../src/ILINTEA/wwwroot/alarm-state.js';

const deadline = Date.parse('2026-10-14T12:00:00Z');
const alarm = {
    visible: true,
    text: '終了 🌟',
    countdownText: 'カウント中\nremaining',
    alarmSchedule: { at: new Date(deadline).toISOString() }
};

test('countdown and its message are shown together until the deadline', () => {
    assert.deepEqual(getAlarmState(alarm, deadline - 61_001), {
        phase: 'counting', remaining: '00:01:02', message: alarm.countdownText
    });
    assert.equal(getAlarmState(alarm, deadline - 1).remaining, '00:00:01');
});

test('the finished message replaces the counting message exactly at the deadline', () => {
    for (const now of [deadline, deadline + 1, deadline + 86_400_000]) {
        assert.deepEqual(getAlarmState(alarm, now), {
            phase: 'finished', remaining: '00:00:00', message: alarm.text
        });
    }
});

test('hidden alarms are inactive before, at and after their deadline', () => {
    for (const now of [deadline - 1, deadline, deadline + 1]) {
        assert.deepEqual(getAlarmState({ ...alarm, visible: false }, now), {
            phase: 'inactive', remaining: '00:00:00', message: alarm.countdownText
        });
    }
});

test('unscheduled or invalid deadlines do not produce a finished alarm or a NaN counter', () => {
    for (const alarmSchedule of [null, undefined, { at: 'invalid' }]) {
        assert.deepEqual(getAlarmState({ ...alarm, alarmSchedule }, deadline), {
            phase: 'inactive', remaining: '00:00:00', message: alarm.countdownText
        });
    }
});

test('the counter retains hours beyond a day and respects the supplied server time', () => {
    assert.equal(getAlarmState(alarm, deadline - (25 * 3600 + 2 * 60 + 3) * 1000).remaining, '25:02:03');
    assert.equal(getAlarmState(alarm, deadline - 1000).phase, 'counting');
    assert.equal(getAlarmState(alarm, deadline).phase, 'finished');
});

test('blank messages do not remove the remaining time', () => {
    const blank = { ...alarm, text: '', countdownText: '' };
    assert.deepEqual(getAlarmState(blank, deadline - 1000), {
        phase: 'counting', remaining: '00:00:01', message: ''
    });
    assert.deepEqual(getAlarmState(blank, deadline), {
        phase: 'finished', remaining: '00:00:00', message: ''
    });
});

test('a delayed alarm starts counting only when displayed and retains its independent deadline', () => {
    const start = deadline - 30_000;
    const scheduled = { ...alarm, displaySchedule: { at: new Date(start).toISOString() } };
    assert.equal(getAlarmState(scheduled, start - 1).phase, 'inactive');
    assert.deepEqual(getAlarmState(scheduled, start), {
        phase: 'counting', remaining: '00:00:30', message: alarm.countdownText
    });
    assert.equal(getAlarmState(scheduled, deadline).phase, 'finished');
    assert.equal(getAlarmState({ ...scheduled, visible: false }, deadline).phase, 'inactive');
});

test('a deadline passed while waiting does not notify until the scheduled display', () => {
    const start = deadline + 30_000;
    const scheduled = { ...alarm, displaySchedule: { at: new Date(start).toISOString() } };
    for (const now of [deadline - 1, deadline, start - 1])
        assert.equal(getAlarmState(scheduled, now).phase, 'inactive');
    assert.deepEqual(getAlarmState(scheduled, start), {
        phase: 'finished', remaining: '00:00:00', message: alarm.text
    });
});
