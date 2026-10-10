using System.Text.RegularExpressions;

namespace StreamPrompter;

public record ScriptControl(string Action, double? Speed)
{
    public bool IsValid() => Action is "play" or "pause" or "reset" ||
        (Action == "speed" && Speed is >= 5 and <= 200);
}

public record ScheduleDisplay(int DelaySeconds);
public record ScheduleAlarm(DateTimeOffset At);
public record CreateElement(string Kind, string? Text = null);
public record MoveElement(int Offset);

public record CanvasPatch(string? AspectRatio, string? BackgroundColor)
{
    public bool IsValid() => (AspectRatio is null or "16:9" or "4:3" or "1:1" or "3:4" or "9:16") &&
        PatchValidation.IsColorValid(BackgroundColor);
}

public record ElementPatch(double? X, double? Y, double? Width, double? Height, string? Text,
    int? FontSize, string? Color, string? Align, bool? Visible, bool? ShowCountdown = null)
{
    public bool IsValid() =>
        new[] { X, Y, Width, Height }.All(value => value is null || double.IsFinite(value.Value)) &&
        (Text is null || UploadLimits.TextFits(Text)) &&
        (FontSize is null or >= 12 and <= 160) &&
        PatchValidation.IsColorValid(Color) &&
        (Align is null or "left" or "center" or "right");
}

internal static class PatchValidation
{
    public static bool IsColorValid(string? color) =>
        color is null || Regex.IsMatch(color, @"\A#[0-9a-fA-F]{6}\z");
}
