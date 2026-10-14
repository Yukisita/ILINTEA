// Keep unsent edits visible while sending patches one at a time.
export function createEditSync({ sendPatch, isConnected, onChange, onError }) {
    const pending = new Map();
    const inFlight = new Map();
    let sending = false;
    let flushTimer;
    let flushTask = null;

    // Callers can wait for all earlier edits before sending a dependent command.
    function flush() {
        clearTimeout(flushTimer);
        if (flushTask) return flushTask;
        if (!isConnected()) return Promise.resolve(false);
        if (pending.size === 0) return Promise.resolve(true);
        flushTask = drain().finally(() => { flushTask = null; });
        return flushTask;
    }

    async function drain() {
        let succeeded = true;
        while (pending.size > 0 && isConnected()) {
            const [id, patch] = pending.entries().next().value;
            pending.delete(id);
            inFlight.set(id, patch);
            sending = true;
            try {
                await sendPatch(id, patch);
            } catch (error) {
                pending.delete(id);
                succeeded = false;
                onError(error);
            } finally {
                inFlight.delete(id);
                sending = false;
                onChange();
            }
        }
        return succeeded && isConnected() && pending.size === 0;
    }

    return {
        get sending() { return sending; },
        get hasPending() { return pending.size > 0; },
        patchFor(id) { return { ...inFlight.get(id), ...pending.get(id) }; },
        queue(id, patch) {
            pending.set(id, { ...pending.get(id), ...patch });
            onChange();
            clearTimeout(flushTimer);
            flushTimer = setTimeout(flush, 100);
        },
        discard(id) { pending.delete(id); },
        clearPending() {
            clearTimeout(flushTimer);
            pending.clear();
        },
        flush
    };
}
