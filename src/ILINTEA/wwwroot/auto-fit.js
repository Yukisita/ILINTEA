import { clockFitSamples } from './clock-format.js?v=20261109-auto-fit';

export const minimumFontSize = 12;

// Search integer CSS pixels; the manual font-size limit does not apply here.
export function fittedFontSize(maximum, fits) {
    let low = minimumFontSize;
    let high = Math.max(low, Math.ceil(maximum));
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(middle)) low = middle;
        else high = middle - 1;
    }
    return low;
}

export function alarmFitSample(element, alarm) {
    if (alarm.phase === 'finished') return '00:00:00';
    // Use the shared creation time so later viewers reserve the same hour digits.
    const duration = Date.parse(element.alarmSchedule?.at) - Date.parse(element.alarmSchedule?.createdAt);
    const hours = Number.isFinite(duration) ? Math.floor(Math.max(0, Math.ceil(duration / 1000)) / 3600) : 0;
    const digits = Math.max(2, String(hours).length, alarm.remaining.split(':')[0].length);
    return `${'0'.repeat(digits)}:00:00`;
}

export function createAutoFitter() {
    let cache = new WeakMap();
    return {
        clear() { cache = new WeakMap(); },
        fit(node, element, { locale, alarm } = {}) {
            const enabled = element.autoFit === true && ['text', 'clock', 'alarm'].includes(element.kind);
            node.classList.toggle('auto-fit', enabled);
            if (!enabled) {
                node.style.fontSize = `${element.fontSize}px`;
                cache.delete(node);
                return;
            }
            const timer = alarm ? alarmFitSample(element, alarm) : '';
            const key = JSON.stringify([element.kind, element.width, element.height, element.align, locale,
                element.kind === 'text' ? element.text : null,
                element.clockHourFormat, element.clockShowSeconds, alarm?.phase, alarm?.message, timer]);
            let result = cache.get(node);
            if (result?.key !== key) {
                result = { key, size: measureFontSize(node, element, locale, alarm, timer) };
                cache.set(node, result);
            }
            node.style.fontSize = `${result.size}px`;
        }
    };
}

function measureFontSize(node, element, locale, alarm, timer) {
    if (element.kind === 'text' && element.text === '') return minimumFontSize;
    // Measure outside the scaled stage, including when the real element is hidden.
    const probe = document.createElement('div');
    probe.className = `element element-${element.kind} auto-fit auto-fit-measure`;
    probe.style.width = `${element.width}px`;
    probe.style.height = `${element.height}px`;
    probe.style.textAlign = element.align;
    probe.style.fontFamily = getComputedStyle(node).fontFamily;
    probe.setAttribute('aria-hidden', 'true');
    probe.inert = true;
    const content = node.firstElementChild.cloneNode(true);
    content.style.height = 'auto';
    content.style.overflow = 'visible';
    probe.append(content);
    if (alarm) {
        content.firstElementChild.textContent = timer;
        // Flex shrinking would conceal overflow and incorrectly accept large text.
        content.lastElementChild.style.flex = 'none';
        content.lastElementChild.style.overflow = 'visible';
    }
    if (element.kind === 'clock') {
        content.replaceChildren(...clockFitSamples(element, locale).map(text => {
            const sample = document.createElement('div');
            sample.style.width = 'max-content';
            sample.textContent = text;
            return sample;
        }));
    }
    document.body.append(probe);
    try {
        const style = getComputedStyle(probe);
        const number = property => parseFloat(style[property]) || 0;
        const height = element.height - number('paddingTop') - number('paddingBottom')
            - number('borderTopWidth') - number('borderBottomWidth');
        const width = content.getBoundingClientRect().width;
        const fits = size => {
            probe.style.fontSize = `${size}px`;
            if (element.kind === 'clock') {
                return [...content.children].every(sample => {
                    const bounds = sample.getBoundingClientRect();
                    return bounds.width <= width && bounds.height <= height;
                });
            }
            if (content.getBoundingClientRect().height > height || content.scrollWidth > content.clientWidth) return false;
            // Check text itself too: scrollWidth/clientWidth round to whole pixels.
            const targets = alarm ? [...content.children] : [content];
            return targets.every(target => {
                const range = document.createRange();
                range.selectNodeContents(target);
                return range.getBoundingClientRect().width <= width;
            });
        };
        // Every nonempty line has a line-height of at least 1 in these element styles.
        return fittedFontSize(element.height, fits);
    } finally {
        probe.remove();
    }
}
