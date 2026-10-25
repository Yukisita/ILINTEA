namespace ILINTEA;

public record Element(Guid Id, string Kind, double X, double Y, double Width, double Height,
    string Text = "", int FontSize = 64, string Color = "#ffffff", string Align = "left", bool Visible = true,
    ScriptPlayback? Playback = null, DisplaySchedule? DisplaySchedule = null, string CountdownText = "",
    long ImageRevision = 0, AlarmSchedule? AlarmSchedule = null)
{
    public string? ImageUrl => Kind == "image" ? $"/api/images/{Id}?v={ImageRevision}" : null;
}

public record ScriptPlayback(double Speed = 30, double Offset = 0, DateTimeOffset? StartedAt = null)
{
    public double PositionAt(DateTimeOffset now) => Offset +
        (StartedAt is { } start ? Math.Max(0, (now - start).TotalSeconds) * Speed : 0);
}

public record DisplaySchedule(Guid Id, DateTimeOffset At);
public record AlarmSchedule(Guid Id, DateTimeOffset At);
public record ScreenHighlight(Guid Id, DateTimeOffset Until);

public record CanvasSettings(string AspectRatio = "16:9", string BackgroundColor = "#000000")
{
    public double Width => AspectRatio switch { "9:16" => 720, "3:4" => 960, _ => 1280 };
    public double Height => AspectRatio switch { "16:9" => 720, "4:3" => 960, _ => 1280 };
}

public record BoardSnapshot(long Revision, long ServerTime, Element[] Elements, CanvasSettings Canvas,
    ScreenHighlight? Highlight = null);
