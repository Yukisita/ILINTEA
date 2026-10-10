using System.IO.Compression;
using System.Text.Json;

namespace StreamPrompter;

// The file contract is independent of live API snapshots and playback state.
internal sealed record BoardConfiguration(string Format, int Version, SavedCanvas Canvas, SavedElement[] Elements);
internal sealed record SavedCanvas(string AspectRatio = "16:9", string BackgroundColor = "#000000");
internal sealed record SavedElement(Guid Id, string Kind, double X, double Y, double Width, double Height,
    string Text = "", int FontSize = 64, string Color = "#ffffff", string Align = "left", bool Visible = false,
    bool ShowCountdown = false, double ScriptSpeed = 30);
internal sealed record BoardBackupState(CanvasSettings Canvas, Element[] Elements, Dictionary<Guid, ImageData> Images);

public sealed class BoardArchiveException(string errorKey) : Exception(errorKey)
{
    public string ErrorKey { get; } = errorKey;
}

public static class BoardArchive
{
    public const int CurrentVersion = 1;
    // Covers every permitted element, including JSON escaping of large scripts.
    public const long MaxArchiveBytes = BoardStore.MaxElements * UploadLimits.MaxRequestBodyBytes;
    private const string Format = "StreamPrompter";
    private const string ManifestName = "settings.json";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public static async Task WriteAsync(Stream destination, BoardStore board, CancellationToken cancellationToken = default)
    {
        var backup = board.CaptureBackup();
        var configuration = new BoardConfiguration(Format, CurrentVersion,
            new(backup.Canvas.AspectRatio, backup.Canvas.BackgroundColor),
            backup.Elements.Select(element => new SavedElement(element.Id, element.Kind,
                element.X, element.Y, element.Width, element.Height, element.Text, element.FontSize,
                element.Color, element.Align, element.Visible,
                element.ShowCountdown, element.Playback?.Speed ?? 30)).ToArray());
        using var archive = new ZipArchive(destination, ZipArchiveMode.Create, leaveOpen: true);
        await using (var manifest = archive.CreateEntry(ManifestName, CompressionLevel.Optimal).Open())
            await JsonSerializer.SerializeAsync(manifest, configuration, Json, cancellationToken);
        foreach (var element in backup.Elements.Where(element => element.Kind == "image"))
        {
            await using var entry = archive.CreateEntry(ImageName(element.Id), CompressionLevel.NoCompression).Open();
            await entry.WriteAsync(backup.Images[element.Id].Bytes, cancellationToken);
        }
    }

    public static async Task<BoardSnapshot> RestoreAsync(Stream source, BoardStore board, CancellationToken cancellationToken = default)
    {
        BoardBackupState backup;
        try
        {
            using var archive = new ZipArchive(source, ZipArchiveMode.Read, leaveOpen: true);
            var manifest = SingleEntry(archive, ManifestName);
            if (manifest.Length > MaxArchiveBytes) throw new BoardArchiveException("errors.settingsFileSize");
            await using var manifestStream = manifest.Open();
            var configuration = await JsonSerializer.DeserializeAsync<BoardConfiguration>(manifestStream, Json, cancellationToken)
                ?? throw new BoardArchiveException("errors.settingsFileFormat");
            if (configuration.Format != Format) throw new BoardArchiveException("errors.settingsFileFormat");
            // Add a reader/migration here when introducing a new incompatible version.
            backup = configuration.Version switch
            {
                1 => await ReadVersion1Async(archive, configuration, cancellationToken),
                _ => throw new BoardArchiveException("errors.settingsFileVersion")
            };
        }
        catch (Exception exception) when (exception is InvalidDataException or JsonException or EndOfStreamException)
        {
            throw new BoardArchiveException("errors.settingsFileFormat");
        }
        cancellationToken.ThrowIfCancellationRequested();
        return board.RestoreBackup(backup);
    }

    private static async Task<BoardBackupState> ReadVersion1Async(ZipArchive archive, BoardConfiguration configuration,
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
                || saved.Text is null || saved.Color is null || saved.Align is null
                || !new ElementPatch(saved.X, saved.Y, saved.Width, saved.Height, saved.Text,
                    saved.FontSize, saved.Color, saved.Align, saved.Visible, saved.ShowCountdown).IsValid()
                || saved.Width < 80 || saved.Height < 48 || saved.X < 0 || saved.Y < 0
                || saved.Width > canvas.Width || saved.Height > canvas.Height
                || saved.X > canvas.Width - saved.Width || saved.Y > canvas.Height - saved.Height
                || !double.IsFinite(saved.ScriptSpeed) || saved.ScriptSpeed is < 5 or > 200
                || (saved.Kind == "script" && string.IsNullOrWhiteSpace(saved.Text)))
                throw new BoardArchiveException("errors.settingsFileFormat");
            elements.Add(new(saved.Id, saved.Kind, saved.X, saved.Y, saved.Width, saved.Height,
                saved.Text, saved.FontSize, saved.Color, saved.Align, saved.Visible,
                saved.Kind == "script" ? new(Speed: saved.ScriptSpeed) : null,
                ShowCountdown: saved.ShowCountdown));
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

    private static string ImageName(Guid id) => $"images/{id:N}";

    private static ZipArchiveEntry SingleEntry(ZipArchive archive, string name)
    {
        var entries = archive.Entries.Where(entry => entry.FullName == name).Take(2).ToArray();
        return entries.Length == 1 ? entries[0] : throw new BoardArchiveException("errors.settingsFileFormat");
    }
}
