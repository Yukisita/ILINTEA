using System.Text.RegularExpressions;
using System.Threading.Channels;

namespace StreamPrompter;

public record Element(Guid Id, string Kind, double X, double Y, double Width, double Height,
    string Text = "", int FontSize = 64, string Color = "#ffffff", string Align = "left", bool Visible = true,
    ScriptPlayback? Playback = null)
{
    public string? ImageUrl => Kind == "image" ? $"/api/images/{Id}" : null;
}

public record ScriptPlayback(double Speed = 30, double Offset = 0, DateTimeOffset? StartedAt = null)
{
    public double PositionAt(DateTimeOffset now) => Offset +
        (StartedAt is { } start ? Math.Max(0, (now - start).TotalSeconds) * Speed : 0);
}
public record ScriptControl(string Action, double? Speed)
{
    public bool IsValid() => Action is "play" or "pause" or "reset" ||
        (Action == "speed" && Speed is >= 5 and <= 200);
}

public record BoardAlarm(Guid Id, DateTimeOffset At, string Message);
public record ScheduleAlarm(DateTimeOffset At, string? Message);
public record BoardSnapshot(long Revision, long ServerTime, Element[] Elements, BoardAlarm? Alarm);
public record CreateElement(string Kind, string? Text = null);
public record ElementPatch(double? X, double? Y, double? Width, double? Height, string? Text,
    int? FontSize, string? Color, string? Align, bool? Visible)
{
    public bool IsValid() =>
        new[] { X, Y, Width, Height }.All(value => value is null || double.IsFinite(value.Value)) &&
        (Text is null || Text.Length <= 50000) &&
        (FontSize is null or >= 12 and <= 160) &&
        (Color is null || Regex.IsMatch(Color, "^#[0-9a-fA-F]{6}$")) &&
        (Align is null or "left" or "center" or "right");
}

public record ImageData(byte[] Bytes, string ContentType)
{
    public static string? DetectContentType(byte[] bytes)
    {
        var span = bytes.AsSpan();
        if (span.StartsWith(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 })) return "image/png";
        if (span.StartsWith(new byte[] { 255, 216, 255 })) return "image/jpeg";
        if (span.StartsWith("GIF87a"u8) || span.StartsWith("GIF89a"u8)) return "image/gif";
        if (span.Length >= 12 && span[..4].SequenceEqual("RIFF"u8) && span.Slice(8, 4).SequenceEqual("WEBP"u8)) return "image/webp";
        return null;
    }
}

// One in-memory board: property patches are serialized so editing text does not overwrite another user's placement.
public sealed class BoardStore
{
    private readonly object gate = new();
    private readonly List<Element> elements =
    [
        new(Guid.NewGuid(), "clock", 880, 24, 368, 88, FontSize: 64, Align: "right"),
        new(Guid.NewGuid(), "text", 80, 220, 1120, 220, "次は新コーナーです\nカメラを見て、お話しください"),
        new(Guid.NewGuid(), "text", 80, 592, 1120, 88, "このあと ゲスト紹介", 48, "#ffff00", "center")
    ];
    private readonly Dictionary<Guid, ImageData> images = [];
    private readonly Dictionary<Guid, Channel<BoardSnapshot>> subscribers = [];
    private long revision;
    private BoardAlarm? alarm;

    public BoardSnapshot Snapshot()
    {
        lock (gate) return SnapshotCore();
    }

    public (Guid Id, ChannelReader<BoardSnapshot> Reader) Subscribe()
    {
        lock (gate)
        {
            var id = Guid.NewGuid();
            var channel = Channel.CreateBounded<BoardSnapshot>(new BoundedChannelOptions(1)
            {
                FullMode = BoundedChannelFullMode.DropOldest
            });
            subscribers.Add(id, channel);
            channel.Writer.TryWrite(SnapshotCore());
            return (id, channel.Reader);
        }
    }

    public void Unsubscribe(Guid id)
    {
        lock (gate)
        {
            if (subscribers.Remove(id, out var channel)) channel.Writer.TryComplete();
        }
    }

    public Element? Add(string kind, ImageData? image = null, string? text = null)
    {
        lock (gate)
        {
            if (elements.Count >= 20) return null;
            var element = kind switch
            {
                "clock" => new Element(Guid.NewGuid(), kind, 880, 24, 368, 88, Align: "right"),
                "image" => new Element(Guid.NewGuid(), kind, 80, 440, 240, 180),
                "script" => new Element(Guid.NewGuid(), kind, 80, 140, 1120, 420, text ?? "", 48, Playback: new()),
                _ => new Element(Guid.NewGuid(), kind, 80, 120, 900, 180, "ここにテキストを入力", 56)
            };
            elements.Add(element);
            if (image is not null) images.Add(element.Id, image);
            Publish();
            return element;
        }
    }

    public Element? Update(Guid id, ElementPatch patch)
    {
        lock (gate)
        {
            var index = elements.FindIndex(element => element.Id == id);
            if (index < 0) return null;
            var current = elements[index];
            var width = Math.Clamp(patch.Width ?? current.Width, 80, 1280);
            var height = Math.Clamp(patch.Height ?? current.Height, 48, 720);
            var updated = current with
            {
                X = Math.Clamp(patch.X ?? current.X, 0, 1280 - width),
                Y = Math.Clamp(patch.Y ?? current.Y, 0, 720 - height),
                Width = width, Height = height,
                Text = patch.Text ?? current.Text,
                FontSize = patch.FontSize ?? current.FontSize,
                Color = patch.Color ?? current.Color,
                Align = patch.Align ?? current.Align,
                Visible = patch.Visible ?? current.Visible,
                Playback = patch.Text is not null && patch.Text != current.Text && current.Playback is { } playback
                    ? playback with { Offset = 0, StartedAt = null } : current.Playback
            };
            elements[index] = updated;
            Publish();
            return updated;
        }
    }

    public bool Remove(Guid id)
    {
        lock (gate)
        {
            if (elements.RemoveAll(element => element.Id == id) == 0) return false;
            images.Remove(id);
            Publish();
            return true;
        }
    }

    public ImageData? GetImage(Guid id)
    {
        lock (gate) return images.GetValueOrDefault(id);
    }

    public Element? ControlScript(Guid id, ScriptControl control)
    {
        lock (gate)
        {
            var index = elements.FindIndex(element => element.Id == id && element.Kind == "script");
            if (index < 0) return null;
            var element = elements[index];
            var playback = element.Playback!;
            var now = DateTimeOffset.UtcNow;
            var position = playback.PositionAt(now);
            playback = control.Action switch
            {
                "play" => playback with { StartedAt = playback.StartedAt ?? now },
                "pause" => playback with { Offset = position, StartedAt = null },
                "reset" => playback with { Offset = 0, StartedAt = null },
                "speed" => playback with { Speed = control.Speed!.Value, Offset = position, StartedAt = playback.StartedAt is null ? null : now },
                _ => playback
            };
            elements[index] = element with { Playback = playback };
            Publish();
            return elements[index];
        }
    }

    public BoardAlarm? SetAlarm(ScheduleAlarm request)
    {
        lock (gate)
        {
            if (request.At <= DateTimeOffset.UtcNow || request.Message?.Length > 120) return null;
            alarm = new(Guid.NewGuid(), request.At.ToUniversalTime(),
                string.IsNullOrWhiteSpace(request.Message) ? "設定した時刻になりました" : request.Message.Trim());
            Publish();
            return alarm;
        }
    }

    public bool ClearAlarm(Guid id)
    {
        lock (gate)
        {
            // An old stop action must not cancel a newly scheduled alarm.
            if (alarm?.Id != id) return false;
            alarm = null;
            Publish();
            return true;
        }
    }

    private BoardSnapshot SnapshotCore() => new(revision, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), elements.ToArray(), alarm);

    private void Publish()
    {
        revision++;
        var snapshot = SnapshotCore();
        foreach (var channel in subscribers.Values) channel.Writer.TryWrite(snapshot);
    }
}
