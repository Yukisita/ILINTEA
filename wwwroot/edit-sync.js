// Keep unsent edits visible while sending patches one at a time.
export function createEditSync({ sendPatch, isConnected, onChange, onError }) {
    const pending = new Map();
    const inFlight = new Map();
    let sending = false;
    let flushTimer;

    async function flush() {
        if (sending || pending.size === 0 || !isConnected()) return;
        clearTimeout(flushTimer);
        const [id, patch] = pending.entries().next().value;
        pending.delete(id);
        inFlight.set(id, patch);
        sending = true;
        try {
            await sendPatch(id, patch);
        } catch (error) {
            pending.delete(id);
            onError(error);
        } finally {
            inFlight.delete(id);
            sending = false;
            onChange();
            void flush();
        }
    }

    return {
        get sending() { return sending; },
        get hasPending() { return pending.size > 0; },
        hasChanges(id) { return pending.has(id) || inFlight.has(id); },
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
