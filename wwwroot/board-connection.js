// WebSockets leave the browser's HTTP connection slots available for editing and page loads.
export function connectBoardEvents({ onOpen, onMessage, onDisconnect }, {
    page = window,
    createSocket = () => {
        const url = new URL('/api/events', page.location.href);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        return new WebSocket(url.href);
    },
    scheduleReconnect = callback => setTimeout(callback, 1500),
    cancelReconnect = timer => clearTimeout(timer)
} = {}) {
    let socket = null;
    let retryTimer = null;
    let active = true;

    function retry() {
        if (!active || retryTimer !== null) return;
        retryTimer = scheduleReconnect(() => {
            retryTimer = null;
            connect();
        });
    }

    function connect() {
        if (!active || socket) return;
        if (retryTimer !== null) { cancelReconnect(retryTimer); retryTimer = null; }
        let current;
        try { current = createSocket(); }
        catch { onDisconnect(); retry(); return; }
        socket = current;
        current.onopen = event => { if (socket === current) onOpen(event); };
        current.onmessage = event => { if (socket === current) onMessage(event); };
        // WebSocket errors are followed by close; only that event schedules a replacement.
        current.onclose = () => {
            if (socket !== current) return;
            socket = null;
            onDisconnect();
            retry();
        };
    }

    function disconnect() {
        active = false;
        if (retryTimer !== null) { cancelReconnect(retryTimer); retryTimer = null; }
        if (!socket) return;
        const previous = socket;
        socket = null;
        previous.close();
        onDisconnect();
    }

    page.addEventListener('pagehide', disconnect);
    page.addEventListener('pageshow', () => { active = true; connect(); });
    connect();
}
