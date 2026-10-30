using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ILINTEA;

// The file contract is independent of live API snapshots and playback state.
internal sealed record BoardConfiguration(string Format, int Version, SavedCanvas Canvas, SavedElement[] Elements);
internal sealed record SavedCanvas(string AspectRatio = "16:9", string BackgroundColor = "#000000");
internal sealed record SavedElement(Guid Id, string Kind, double X, double Y, double Width, double Height,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Text = "",
    int FontSize = 64, string Color = "#ffffff", string Align = "left", bool Visible = false,
    string CountdownText = "", double ScriptSpeed = 30,
    int ClockHourFormat = 24, bool ClockShowSeconds = true,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ScriptFile = null);
internal sealed record BoardBackupState(CanvasSettings Canvas, Element[] Elements, Dictionary<Guid, ImageData> Images);

public sealed class BoardArchiveException(string errorKey) : Exception(errorKey)
{
    public string ErrorKey { get; } = errorKey;
}

public static class BoardArchive
{
    public const int CurrentVersion = 1;
    // Allows room for file entries and JSON metadata in an uploaded settings ZIP.
    public const long MaxArchiveBytes = BoardStore.MaxElements * UploadLimits.MaxRequestBodyBytes;
    // Applies only to the uncompressed settings.json, not to image or script entries.
    public const long MaxManifestBytes = 512L * 1024 * 1024;
    private const string Format = "ILINTEA";
    private const string ManifestName = "settings.json";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    public static async Task WriteAsync(Stream destination, BoardStore board, CancellationToken cancellationToken = default)
    {
        var backup = board.CaptureBackup();
        var configuration = new BoardConfiguration(Format, CurrentVersion,
            new(backup.Canvas.AspectRatio, backup.Canvas.BackgroundColor),
            backup.Elements.Select(element => new SavedElement(element.Id, element.Kind,
                element.X, element.Y, element.Width, element.Height, element.Kind == "script" ? null : element.Text, element.FontSize,
                element.Color, element.Align, element.Visible,
                element.CountdownText, element.Playback?.Speed ?? 30,
                element.ClockHourFormat, element.ClockShowSeconds,
                element.Kind == "script" ? ScriptName(element.Id) : null)).ToArray());
        using var archive = new ZipArchive(destination, ZipArchiveMode.Create, leaveOpen: true);
        await using (var manifest = archive.CreateEntry(ManifestName, CompressionLevel.Optimal).Open())
            await JsonSerializer.SerializeAsync(manifest, configuration, Json, cancellationToken);
        foreach (var element in backup.Elements.Where(element => element.Kind == "image"))
        {
            await using var entry = archive.CreateEntry(ImageName(element.Id), CompressionLevel.NoCompression).Open();
            await entry.WriteAsync(backup.Images[element.Id].Bytes, cancellationToken);
        }
        foreach (var element in backup.Elements.Where(element => element.Kind == "script"))
        {
            // Encode directly into the ZIP instead of allocating a second copy of the entire script.
            await using var entry = archive.CreateEntry(ScriptName(element.Id), CompressionLevel.Optimal).Open();
            await using var writer = new StreamWriter(entry, Utf8, bufferSize: 16 * 1024, leaveOpen: true);
            await writer.WriteAsync(element.Text.AsMemory(), cancellationToken);
            await writer.FlushAsync(cancellationToken);
        }
    }

    public static async Task<BoardSnapshot> RestoreAsync(Stream source, BoardStore board, CancellationToken cancellationToken = default)
    {
        BoardBackupState backup;
        try
        {
            using var archive = new ZipArchive(source, ZipArchiveMode.Read, leaveOpen: true);
            var manifest = SingleEntry(archive, ManifestName);
            if (manifest.Length > MaxManifestBytes) throw new BoardArchiveException("errors.settingsFileSize");
            // Check the count before the serializer allocates the element array or its strings.
            await ValidateManifestAsync(manifest, cancellationToken);
            await using var manifestStream = new EntryReadStream(manifest.Open(), manifest.Length);
            var configuration = await JsonSerializer.DeserializeAsync<BoardConfiguration>(manifestStream, Json, cancellationToken)
                ?? throw new BoardArchiveException("errors.settingsFileFormat");
            if (configuration.Format != Format) throw new BoardArchiveException("errors.settingsFileFormat");
            if (configuration.Version != CurrentVersion) throw new BoardArchiveException("errors.settingsFileVersion");
            backup = await ReadConfigurationAsync(archive, configuration, cancellationToken);
        }
        catch (Exception exception) when (exception is InvalidDataException or JsonException or EndOfStreamException or DecoderFallbackException)
        {
            throw new BoardArchiveException("errors.settingsFileFormat");
        }
        cancellationToken.ThrowIfCancellationRequested();
        return board.RestoreBackup(backup);
    }

    private static async Task ValidateManifestAsync(ZipArchiveEntry manifest, CancellationToken cancellationToken)
    {
        await using var stream = new EntryReadStream(manifest.Open(), manifest.Length);
        var buffer = new byte[(int)Math.Min(16 * 1024, manifest.Length + 1)];
        var buffered = 0;
        var firstBlock = true;
        var validator = new ManifestValidator();
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (buffered == buffer.Length)
                Array.Resize(ref buffer, (int)Math.Min(buffer.LongLength * 2, manifest.Length + 1));
            var read = await stream.ReadAsync(buffer.AsMemory(buffered), cancellationToken);
            buffered += read;
            if (firstBlock)
            {
                // Match JsonSerializer's support for an optional UTF-8 BOM, including split reads.
                if (buffered < 3 && read != 0) continue;
                if (buffer.AsSpan(0, buffered).StartsWith("\uFEFF"u8))
                {
                    buffer.AsSpan(3, buffered - 3).CopyTo(buffer);
                    buffered -= 3;
                }
                firstBlock = false;
            }
            var consumed = validator.Consume(buffer.AsSpan(0, buffered), read == 0);
            buffered -= consumed;
            buffer.AsSpan(consumed, buffered).CopyTo(buffer);
            if (read == 0) return;
        }
    }

    private sealed class ManifestValidator
    {
        private JsonReaderState state;
        private bool expectingElements;
        private bool readingElements;
        private int elementCount;

        public int Consume(ReadOnlySpan<byte> bytes, bool isFinalBlock)
        {
            var reader = new Utf8JsonReader(bytes, isFinalBlock, state);
            while (reader.Read())
            {
                if (readingElements && reader.CurrentDepth == 2
                    && reader.TokenType is not (JsonTokenType.EndObject or JsonTokenType.EndArray or JsonTokenType.PropertyName)
                    && ++elementCount > BoardStore.MaxElements)
                    throw new BoardArchiveException("errors.settingsFileFormat");
                if (readingElements && reader.TokenType == JsonTokenType.EndArray && reader.CurrentDepth == 1)
                    readingElements = false;
                if (expectingElements)
                {
                    readingElements = reader.TokenType == JsonTokenType.StartArray;
                    elementCount = 0;
                    expectingElements = false;
                }
                if (reader.TokenType == JsonTokenType.PropertyName && reader.CurrentDepth == 1)
                {
                    // Bound property-name allocations and preserve web JSON's case/escape handling.
                    try
                    {
                        expectingElements = reader.ValueSpan.Length <= 6 * "elements".Length
                            && string.Equals(reader.GetString(), "elements", StringComparison.OrdinalIgnoreCase);
                    }
                    catch (InvalidOperationException exception)
                    {
                        throw new JsonException("Invalid JSON property name encoding.", exception);
                    }
                }
            }
            state = reader.CurrentState;
            return checked((int)reader.BytesConsumed);
        }
    }

    // Enforce the actual decompressed byte count too, even if ZIP metadata understates it.
    private sealed class EntryReadStream(Stream inner, long limit) : Stream
    {
        private long remaining = limit;
        public long Remaining => remaining;
        public override bool CanRead => inner.CanRead;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));
        public override int Read(Span<byte> buffer) => CountRead(inner.Read(buffer[..ReadLength(buffer.Length)]));
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
            CountRead(await inner.ReadAsync(buffer[..ReadLength(buffer.Length)], cancellationToken));
        private int ReadLength(int requested) => (int)Math.Min(requested, remaining + 1);
        private int CountRead(int count)
        {
            if (count > remaining) throw new BoardArchiveException("errors.settingsFileSize");
            remaining -= count;
            return count;
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing) inner.Dispose();
            base.Dispose(disposing);
        }
        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private static async Task<BoardBackupState> ReadConfigurationAsync(ZipArchive archive, BoardConfiguration configuration,
        CancellationToken cancellationToken)
    {
        if (configuration.Canvas is not { AspectRatio: not null, BackgroundColor: not null } savedCanvas
            || !new CanvasPatch(savedCanvas.AspectRatio, savedCanvas.BackgroundColor).IsValid()
            || configuration.Elements is null || configuration.Elements.Length > BoardStore.MaxElements)
            throw new BoardArchiveException("errors.settingsFileFormat");
        var canvas = new CanvasSettings(savedCanvas.AspectRatio, savedCanvas.BackgroundColor);
        var elements = new List<Element>();
        var images = new Dictionary<Guid, ImageData>();
        var ids = new HashSet<Guid>();
        foreach (var saved in configuration.Elements)
        {
            if (saved is null || saved.Id == Guid.Empty || !ids.Add(saved.Id)
                || saved.Kind is not ("text" or "clock" or "image" or "script" or "alarm")
                || saved.CountdownText is null || saved.Color is null || saved.Align is null
                || (saved.Kind == "script"
                    ? saved.ScriptFile != ScriptName(saved.Id) || !string.IsNullOrEmpty(saved.Text)
                    : saved.ScriptFile is not null || saved.Text is null)
                || !new ElementPatch(saved.X, saved.Y, saved.Width, saved.Height, saved.Text,
                    saved.FontSize, saved.Color, saved.Align, saved.Visible, saved.CountdownText,
                    saved.ClockHourFormat, saved.ClockShowSeconds).IsValid()
                || saved.Width < 80 || saved.Height < 48 || saved.X < 0 || saved.Y < 0
                || saved.Width > canvas.Width || saved.Height > canvas.Height
                || saved.X > canvas.Width - saved.Width || saved.Y > canvas.Height - saved.Height
                || !double.IsFinite(saved.ScriptSpeed) || saved.ScriptSpeed is < 5 or > 200)
                throw new BoardArchiveException("errors.settingsFileFormat");
            var text = saved.ScriptFile is not null
                ? await ReadScriptAsync(archive, saved.ScriptFile, cancellationToken) : saved.Text!;
            elements.Add(new(saved.Id, saved.Kind, saved.X, saved.Y, saved.Width, saved.Height,
                text, saved.FontSize, saved.Color, saved.Align, saved.Kind != "alarm" && saved.Visible,
                saved.Kind == "script" ? new(Speed: saved.ScriptSpeed) : null,
                CountdownText: saved.CountdownText,
                ClockHourFormat: saved.ClockHourFormat, ClockShowSeconds: saved.ClockShowSeconds));
            if (saved.Kind != "image") continue;
            var entry = SingleEntry(archive, ImageName(saved.Id));
            if (entry.Length is <= 0 or > UploadLimits.MaxFileBytes)
                throw new BoardArchiveException("errors.settingsFileSize");
            var bytes = new byte[checked((int)entry.Length)];
            await using var stream = entry.Open();
            await stream.ReadExactlyAsync(bytes, cancellationToken);
            var contentType = ImageData.DetectContentType(bytes)
                ?? throw new BoardArchiveException("errors.settingsFileFormat");
            images.Add(saved.Id, new(bytes, contentType));
        }
        return new(canvas, elements.ToArray(), images);
    }

    private static async Task<string> ReadScriptAsync(ZipArchive archive, string name, CancellationToken cancellationToken)
    {
        var entry = SingleEntry(archive, name);
        if (entry.Length > UploadLimits.MaxFileBytes)
            throw new BoardArchiveException("errors.settingsFileSize");
        await using var stream = new EntryReadStream(entry.Open(), entry.Length);
        // Keep every character, including an edited leading U+FEFF, and reject invalid UTF-8.
        using var reader = new StreamReader(stream, Utf8, detectEncodingFromByteOrderMarks: false, bufferSize: 16 * 1024);
        var text = await reader.ReadToEndAsync(cancellationToken);
        if (stream.Remaining != 0) throw new EndOfStreamException();
        return text;
    }

    private static string ImageName(Guid id) => $"images/{id:N}";
    private static string ScriptName(Guid id) => $"scripts/{id:N}.txt";

    private static ZipArchiveEntry SingleEntry(ZipArchive archive, string name)
    {
        var entries = archive.Entries.Where(entry => entry.FullName == name).Take(2).ToArray();
        return entries.Length == 1 ? entries[0] : throw new BoardArchiveException("errors.settingsFileFormat");
    }
}
