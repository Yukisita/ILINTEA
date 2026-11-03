import { elementIsVisible } from './display-state.js?v=20261017';

// All alarm surfaces use the same server-adjusted time and visibility rules.
export function getAlarmState(element, now) {
    const deadline = Date.parse(element.alarmSchedule?.at);
    const enabled = elementIsVisible(element, now) && Number.isFinite(deadline);
    const phase = !enabled ? 'inactive' : deadline > now ? 'counting' : 'finished';
    const seconds = enabled ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;
    const pad = value => String(value).padStart(2, '0');
    return {
        phase,
        remaining: `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`,
        message: phase === 'finished' ? element.text : element.countdownText
    };
}
