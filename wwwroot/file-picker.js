// Capture the replacement target before opening the picker, and allow selecting the same file again.
export function bindFilePicker(button, input, loadFile, { getTarget = () => null, canOpen = () => true } = {}) {
    let selection = null;
    button.addEventListener('click', () => {
        const target = getTarget();
        if (!canOpen(target)) return;
        selection = { target };
        input.click();
    });
    input.addEventListener('cancel', () => { selection = null; });
    input.addEventListener('change', async () => {
        const current = selection;
        selection = null;
        try {
            const file = input.files[0];
            if (current && file) await loadFile(file, current.target);
        } finally {
            input.value = '';
        }
    });
}
