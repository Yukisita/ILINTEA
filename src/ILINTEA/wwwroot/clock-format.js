export function createClockFormatter(locale) {
    const formatters = new Map();
    return (element, time) => {
        const hourFormat = element.clockHourFormat === 12 ? 12 : 24;
        const showSeconds = element.clockShowSeconds !== false;
        const key = `${hourFormat}:${showSeconds}`;
        if (!formatters.has(key)) {
            formatters.set(key, new Intl.DateTimeFormat(locale, {
                hour: '2-digit', minute: '2-digit',
                ...(showSeconds ? { second: '2-digit' } : {}),
                hourCycle: hourFormat === 12 ? 'h12' : 'h23'
            }));
        }
        return formatters.get(key).format(time);
    };
}
