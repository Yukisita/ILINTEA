using StreamPrompter;

var passed = 0;
Run("Patches clamp element size and position to the canvas", () =>
{
    var board = new BoardStore();
    var id = board.Add("text")!.Id;
    var element = board.Update(id, Patch(x: -100, y: 9000, width: 1, height: 9000))!;
    Equal(0, element.X);
    Equal(0, element.Y);
    Equal(80, element.Width);
    Equal(720, element.Height);
    element = board.Update(id, Patch(x: 9000, y: 9000, width: 9000, height: 1))!;
    Equal(0, element.X);
    Equal(672, element.Y);
    Equal(1280, element.Width);
    Equal(48, element.Height);
});

Run("Partial patches retain placement and unrelated properties", () =>
{
    var board = new BoardStore();
    var original = board.Add("text")!;
    var updated = board.Update(original.Id, Patch(text: "updated"))!;
    Equal(original with { Text = "updated" }, updated);
});

Run("Aspect ratio changes scale position and size proportionally", () =>
{
    var board = new BoardStore();
    var id = board.Add("text")!.Id;
    board.Update(id, Patch(x: 200, y: 100, width: 400, height: 200));
    board.UpdateCanvas(new("9:16", null));
    var element = board.Snapshot().Elements.Single();
    Equal(112.5, element.X);
    Equal(100 * (1280d / 720), element.Y);
    Equal(225, element.Width);
    Equal(200 * (1280d / 720), element.Height);
});

Run("Elements stay within every supported canvas after creation and resizing", () =>
{
    var board = new BoardStore();
    foreach (var ratio in new[] { "16:9", "4:3", "1:1", "3:4", "9:16", "16:9" })
    {
        board.UpdateCanvas(new(ratio, null));
        var added = board.Add("clock")!;
        board.Update(added.Id, Patch(x: 9000, y: 9000, width: 1, height: 1));
        var snapshot = board.Snapshot();
        foreach (var element in snapshot.Elements)
            Assert(element.Width >= 80 && element.Height >= 48 && element.X >= 0 && element.Y >= 0
                && element.X + element.Width <= snapshot.Canvas.Width
                && element.Y + element.Height <= snapshot.Canvas.Height, "Element exceeds canvas bounds");
    }
});

Run("Canvas and element colors use the same strict validation", () =>
{
    foreach (var (color, valid) in new (string?, bool)[]
    {
        (null, true), ("#123aBC", true), ("#ffffff", true),
        ("#fff", false), ("#1234567", false), ("#12345g", false),
        ("#123456\n", false), ("\n#123456", false), (" #123456", false)
    })
    {
        Equal(valid, new CanvasPatch(null, color).IsValid());
        Equal(valid, (Patch() with { Color = color }).IsValid());
    }
});

Run("Image detection accepts supported signatures and rejects incomplete or unknown data", () =>
{
    Equal("image/png", ImageData.DetectContentType([137, 80, 78, 71, 13, 10, 26, 10]));
    Equal("image/jpeg", ImageData.DetectContentType([255, 216, 255]));
    Equal("image/gif", ImageData.DetectContentType("GIF87a"u8.ToArray()));
    Equal("image/gif", ImageData.DetectContentType("GIF89a"u8.ToArray()));
    Equal("image/webp", ImageData.DetectContentType("RIFFxxxxWEBP"u8.ToArray()));
    Equal<string?>(null, ImageData.DetectContentType("RIFFxxxxWEB"u8.ToArray()));
    Equal<string?>(null, ImageData.DetectContentType("unknown"u8.ToArray()));
    Equal<string?>(null, ImageData.DetectContentType([]));
});

Run("Snapshots and subscription events use the supplied clock", () =>
{
    var clock = new ManualTimeProvider();
    var board = new BoardStore(clock);
    var subscription = board.Subscribe();
    Assert(subscription.Reader.TryRead(out var initial), "Missing initial snapshot");
    Equal(clock.Now.ToUnixTimeMilliseconds(), initial!.ServerTime);
    clock.Now += TimeSpan.FromSeconds(10);
    board.Add("text");
    Assert(subscription.Reader.TryRead(out var updated), "Missing update event");
    Equal(clock.Now.ToUnixTimeMilliseconds(), updated!.ServerTime);
    Equal(updated.ServerTime, board.Snapshot().ServerTime);
    Equal(initial.Revision + 1, updated.Revision);
    board.Unsubscribe(subscription.Id);
});

Run("Playback retains its position across speed changes, pause and resume", () =>
{
    var clock = new ManualTimeProvider();
    var board = new BoardStore(clock);
    var id = board.Add("script", text: "script")!.Id;
    board.ControlScript(id, new("play", null));
    clock.Now += TimeSpan.FromSeconds(3);
    var playback = board.ControlScript(id, new("speed", 60))!.Playback!;
    Equal(90, playback.PositionAt(clock.Now));
    clock.Now += TimeSpan.FromSeconds(2);
    playback = board.ControlScript(id, new("pause", null))!.Playback!;
    Equal(210, playback.Offset);
    Equal<DateTimeOffset?>(null, playback.StartedAt);
    clock.Now += TimeSpan.FromSeconds(5);
    playback = board.ControlScript(id, new("play", null))!.Playback!;
    clock.Now += TimeSpan.FromSeconds(2);
    Equal(330, playback.PositionAt(clock.Now));
    playback = board.ControlScript(id, new("reset", null))!.Playback!;
    Equal(0, playback.Offset);
    Equal<DateTimeOffset?>(null, playback.StartedAt);
});

Run("Scheduled playback waits until its start and cannot be canceled at or after that time", () =>
{
    var clock = new ManualTimeProvider();
    var board = new BoardStore(clock);
    var id = board.Add("script", text: "script")!.Id;
    board.ControlScript(id, new("play", null));
    clock.Now += TimeSpan.FromSeconds(2);
    var scheduled = board.ScheduleDisplay(id, 10)!;
    var schedule = scheduled.DisplaySchedule!;
    Equal(clock.Now.AddSeconds(10), schedule.At);
    Equal<DateTimeOffset?>(schedule.At, scheduled.Playback!.StartedAt);
    clock.Now += TimeSpan.FromSeconds(9);
    var playback = board.ControlScript(id, new("speed", 50))!.Playback!;
    Equal(60, playback.PositionAt(clock.Now));
    clock.Now += TimeSpan.FromSeconds(1);
    Equal(60, playback.PositionAt(clock.Now));
    Assert(!board.CancelDisplay(id, schedule.Id), "Display canceled at its start time");
    clock.Now += TimeSpan.FromSeconds(1);
    Equal(110, playback.PositionAt(clock.Now));
    Assert(!board.CancelDisplay(id, schedule.Id), "Display canceled after its start time");
});

Run("Canceling a future display hides it and pauses playback at its current position", () =>
{
    var clock = new ManualTimeProvider();
    var board = new BoardStore(clock);
    var id = board.Add("script", text: "script")!.Id;
    board.ControlScript(id, new("play", null));
    clock.Now += TimeSpan.FromSeconds(2);
    var schedule = board.ScheduleDisplay(id, 10)!.DisplaySchedule!;
    Assert(!board.CancelDisplay(id, Guid.NewGuid()), "Wrong schedule ID was accepted");
    Assert(board.CancelDisplay(id, schedule.Id), "Future display was not canceled");
    var element = board.Snapshot().Elements.Single();
    Assert(!element.Visible && element.DisplaySchedule is null, "Canceled display is still scheduled or visible");
    Equal(60, element.Playback!.Offset);
    Equal<DateTimeOffset?>(null, element.Playback.StartedAt);
});

Run("Alarms reject past and current times and remain cancelable after starting", () =>
{
    var clock = new ManualTimeProvider();
    var board = new BoardStore(clock);
    var id = board.Add("alarm")!.Id;
    Equal<Element?>(null, board.ScheduleAlarm(id, new(clock.Now.AddSeconds(-1))));
    Equal<Element?>(null, board.ScheduleAlarm(id, new(clock.Now)));
    var scheduled = board.ScheduleAlarm(id, new(clock.Now.AddSeconds(10).ToOffset(TimeSpan.FromHours(9))))!;
    Equal(clock.Now.AddSeconds(10), scheduled.DisplaySchedule!.At);
    Equal(TimeSpan.Zero, scheduled.DisplaySchedule.At.Offset);
    clock.Now += TimeSpan.FromSeconds(10);
    Assert(board.CancelDisplay(id, scheduled.DisplaySchedule.Id), "Started alarm was not canceled");
    Assert(!board.Snapshot().Elements.Single().Visible, "Canceled alarm is still visible");
});

passed += await BoardArchiveTests.RunAsync();
Console.WriteLine($"{passed} tests passed.");

void Run(string name, Action test)
{
    test();
    passed++;
    Console.WriteLine($"PASS: {name}");
}

static ElementPatch Patch(double? x = null, double? y = null, double? width = null, double? height = null, string? text = null) =>
    new(x, y, width, height, text, null, null, null, null);

static void Equal<T>(T expected, T actual) =>
    Assert(EqualityComparer<T>.Default.Equals(expected, actual), $"Expected {expected}; actual {actual}");

static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

sealed class ManualTimeProvider : TimeProvider
{
    public DateTimeOffset Now { get; set; } = DateTimeOffset.UnixEpoch;
    public override DateTimeOffset GetUtcNow() => Now;
}
