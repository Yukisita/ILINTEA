// Use the same native image decoder as the displayed <img>, without trusting the
// file extension or MIME type. Always release the temporary URL, even on failure.
export async function canDecodeImage(file) {
    const url = URL.createObjectURL(file);
    const image = new Image();
    try {
        image.src = url;
        await image.decode();
        return image.naturalWidth > 0 && image.naturalHeight > 0;
    } catch {
        return false;
    } finally {
        image.removeAttribute('src');
        URL.revokeObjectURL(url);
    }
}
