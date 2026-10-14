// Cached pages must release their HTTP connection and reconnect when restored.
export function connectBoardEvents({ onOpen, onMessage, onDisconnect }, {
    page = window,
    createSource = () => new EventSource('/api/events')
} = {}) {
    let source = null;

    function connect() {
        if (source) return;
        const current = createSource();
        source = current;
        current.onopen = event => { if (source === current) onOpen(event); };
        current.onmessage = event => { if (source === current) onMessage(event); };
        current.onerror = () => { if (source === current) onDisconnect(); };
    }

    function disconnect() {
        if (!source) return;
        const previous = source;
        source = null;
        previous.close();
        onDisconnect();
    }

    page.addEventListener('pagehide', disconnect);
    page.addEventListener('pageshow', connect);
    connect();
}
