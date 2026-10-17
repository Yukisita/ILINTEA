export function displayIsWaiting(element, now) {
    return element.visible && Date.parse(element.displaySchedule?.at) > now;
}

export function elementIsVisible(element, now) {
    return element.visible && !displayIsWaiting(element, now);
}
