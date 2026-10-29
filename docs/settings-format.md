# Settings archive

`GET /api/settings/download` downloads a ZIP file. `POST /api/settings/upload`
accepts the ZIP bytes as the request body and returns the restored board snapshot.

The archive contains UTF-8 `settings.json`, an `images/{elementId:N}` entry
for each image element, and a `scripts/{elementId:N}.txt` entry for each TXT script.
Images retain their original bytes; MIME types are detected again during import.
Scripts contain the currently edited text encoded as UTF-8, without adding a BOM.
Entries are read in place and never extracted to disk paths.

On import, the uncompressed `settings.json` is limited to 512 MiB (536,870,912
bytes), independently of the image/script entries and the ZIP upload limit. Both the ZIP
entry's declared length and the actual decompressed byte count are checked. A
streaming validation pass rejects more than 20 elements before deserializing the
configuration. Size and count errors leave the current board unchanged. Script
bodies are outside the JSON and do not count toward this manifest limit.

The JSON envelope has `format: "ILINTEA"`, `version: 1`, `canvas`, and
`elements`. Canvas settings contain `aspectRatio` and `backgroundColor`.
Elements contain their ID, kind, coordinates, dimensions, text, font size, color,
alignment, visibility, `countdownText`, and script speed. For alarms, `countdownText`
is the counting message and `text` is the finished message. Array order is the
layer order, from front to back.

Script elements omit `text` when saving and instead specify
`scriptFile: "scripts/{elementId:N}.txt"`. The reference must match the element's
ID and identify exactly one ZIP entry. Nonempty inline script text, missing or
duplicate entries, and invalid UTF-8 are rejected. Other element kinds cannot
specify `scriptFile`. Each script entry is limited to 1 GiB (1,073,741,824 bytes),
checked against both its declared length and the bytes actually read. Encoding
and decoding use buffered streams instead of a separate full-size byte array.
Script text cleared during editing may be empty or whitespace-only; saving and
restoring preserves all characters, including line endings and a leading U+FEFF.

Clock display settings are stored in the optional `clockHourFormat` (12 or 24,
default 24) and `clockShowSeconds` (boolean, default true) fields. Archives that
omit them use 24-hour display with hours, minutes and seconds.

Live timestamps, revisions, image URLs, script scroll position, display schedules,
alarm deadlines, and transient screen highlights are excluded. Pending displays
are saved hidden; already displayed elements retain their visibility. Scripts
restore paused at the beginning.
Alarms always restore hidden and disarmed; both messages are preserved.
Restore assigns fresh element IDs, preventing stale client edits and image cache
entries from modifying the restored board. A successful restore publishes one
state update; invalid files never modify the board.

Keep the saved DTOs separate from runtime models. This release uses format version 1.
Unknown JSON properties are ignored. Unsupported versions and unknown element
kinds are rejected rather than restored partially. Test round trips and failure
atomicity whenever changing this format.
