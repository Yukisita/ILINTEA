// Keep the current document and its live connection when a link points back to it.
export function preventSamePageNavigation(links, location = window.location) {
    for (const link of links) {
        link.addEventListener('click', event => {
            if (event.defaultPrevented || event.button !== 0
                || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
                || (link.target && link.target !== '_self') || link.hasAttribute('download')) return;
            if (new URL(link.href, location.href).href === location.href) event.preventDefault();
        });
    }
}
