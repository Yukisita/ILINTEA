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

Run("Every element kind supports replacing and canceling a display schedule", () =>
{
    foreach (var kind in new[] { "text", "clock", "image", "script", "alarm" })
    {
        var clock = new ManualTimeProvider();
        var board = new BoardStore(clock);
        var id = board.Add(kind)!.Id;
        var first = board.ScheduleDisplay(id, 10, clock.Now.AddMinutes(1))!;
        Assert(first.Visible, "Scheduled display was not enabled");
        Equal(clock.Now.AddSeconds(10), first.DisplaySchedule!.At);
        if (kind == "alarm") Equal(clock.Now.AddMinutes(1), first.AlarmSchedule!.At);
        else Equal<AlarmSchedule?>(null, first.AlarmSchedule);
        var updated = board.ScheduleDisplay(id, 20, clock.Now.AddMinutes(2))!;
        Equal(clock.Now.AddSeconds(20), updated.DisplaySchedule!.At);
        var revision = board.Snapshot().Revision;
        Assert(!board.CancelDisplay(id, first.DisplaySchedule.Id), "Old cancellation removed a new reservation");
        Equal(revision, board.Snapshot().Revision);
        Assert(board.CancelDisplay(id, updated.DisplaySchedule.Id), "Current reservation was not canceled");
        var canceled = board.Snapshot().Elements.Single();
        Assert(!canceled.Visible && canceled.DisplaySchedule is null && canceled.AlarmSchedule is null,
            "Canceled element remained scheduled or armed");
    }
});

Run("Delayed alarm edits retain display time and immediate display retains its deadline", () =>
{
    var clock = new ManualTimeProvider();
    var board = new BoardStore(clock);
    var id = board.Add("alarm")!.Id;
    var scheduled = board.ScheduleDisplay(id, 10, clock.Now.AddMinutes(1))!;
    var edited = board.Update(id, Patch(text: "finished") with { CountdownText = "counting" })!;
    Equal(scheduled.DisplaySchedule, edited.DisplaySchedule);
    Equal(scheduled.AlarmSchedule, edited.AlarmSchedule);
    var changed = board.ScheduleAlarm(id, new(clock.Now.AddMinutes(2)))!;
    Equal(scheduled.DisplaySchedule, changed.DisplaySchedule);
    Equal(clock.Now.AddMinutes(2), changed.AlarmSchedule!.At);
    Assert(!board.CancelAlarm(id, scheduled.AlarmSchedule!.Id), "Stale alarm stop canceled the updated deadline");
    var shown = board.Update(id, Patch() with { Visible = true })!;
    Assert(shown.Visible && shown.DisplaySchedule is null, "Alarm was not displayed immediately");
    Equal(changed.AlarmSchedule, shown.AlarmSchedule);
    Assert(!board.CancelDisplay(id, scheduled.DisplaySchedule!.Id), "Stale reservation canceled a displayed alarm");
});

Run("Hiding a delayed alarm clears both schedules and prevents a later notification", () =>
{
    var clock = new ManualTimeProvider();
    var board = new BoardStore(clock);
    var id = board.Add("alarm")!.Id;
    var scheduled = board.ScheduleDisplay(id, 10, clock.Now.AddMinutes(1))!;
    var hidden = board.Update(id, Patch() with { Visible = false })!;
    Assert(!hidden.Visible && hidden.DisplaySchedule is null && hidden.AlarmSchedule is null, "Hidden alarm retained a schedule");
    clock.Now += TimeSpan.FromMinutes(2);
    Equal(hidden, board.Snapshot().Elements.Single());
    Assert(!board.CancelDisplay(id, scheduled.DisplaySchedule!.Id), "Old display schedule is still active");
    Assert(!board.CancelAlarm(id, scheduled.AlarmSchedule!.Id), "Old alarm deadline is still active");
});

Run("An alarm's display reservation expires independently of its deadline", () =>
{
    var clock = new ManualTimeProvider();
    var board = new BoardStore(clock);
    var id = board.Add("alarm")!.Id;
    var scheduled = board.ScheduleDisplay(id, 10, clock.Now.AddSeconds(5))!;
    clock.Now += TimeSpan.FromSeconds(10);
    Assert(!board.CancelDisplay(id, scheduled.DisplaySchedule!.Id), "Display canceled after its scheduled start");
    Assert(board.CancelAlarm(id, scheduled.AlarmSchedule!.Id), "Finished alarm could not be stopped");
    var stopped = board.Snapshot().Elements.Single();
    Assert(!stopped.Visible && stopped.DisplaySchedule is null && stopped.AlarmSchedule is null, "Stopped alarm remained armed");
});

Run("Invalid delayed alarms leave the existing schedules untouched and publish nothing", () =>
{
    var clock = new ManualTimeProvider();
    var board = new BoardStore(clock);
    var id = board.Add("alarm")!.Id;
    board.ScheduleDisplay(id, 10, clock.Now.AddMinutes(1));
    var before = board.Snapshot();
    var subscription = board.Subscribe();
    subscription.Reader.TryRead(out _);
    foreach (var deadline in new DateTimeOffset?[] { null, clock.Now, clock.Now.AddSeconds(-1) })
        Equal<Element?>(null, board.ScheduleDisplay(id, 20, deadline));
    foreach (var delay in new[] { 0, -1, 86401, int.MaxValue })
        Equal<Element?>(null, board.ScheduleDisplay(id, delay, clock.Now.AddMinutes(1)));
    Equal(before.Revision, board.Snapshot().Revision);
    Equal(before.Elements.Single(), board.Snapshot().Elements.Single());
    Assert(!subscription.Reader.TryRead(out _), "Rejected schedule published an event");
    board.Unsubscribe(subscription.Id);
});

Run("Alarms reject past and current times and remain cancelable after starting", () =>
{
    var clock = new ManualTimeProvider();
    var board = new BoardStore(clock);
    var id = board.Add("alarm")!.Id;
    Equal<Element?>(null, board.ScheduleAlarm(id, new(clock.Now.AddSeconds(-1))));
    Equal<Element?>(null, board.ScheduleAlarm(id, new(clock.Now)));
    var scheduled = board.ScheduleAlarm(id, new(clock.Now.AddSeconds(10).ToOffset(TimeSpan.FromHours(9))))!;
    Equal(clock.Now.AddSeconds(10), scheduled.AlarmSchedule!.At);
    Equal(TimeSpan.Zero, scheduled.AlarmSchedule.At.Offset);
    clock.Now += TimeSpan.FromSeconds(10);
    Assert(board.CancelAlarm(id, scheduled.AlarmSchedule.Id), "Started alarm was not canceled");
    Assert(!board.Snapshot().Elements.Single().Visible, "Canceled alarm is still visible");
});

Run("Alarm message edits and repeated show patches retain the running deadline", () =>
{
    var clock = new ManualTimeProvider();
    var board = new BoardStore(clock);
    var alarm = board.Add("alarm", text: "finished", countdownText: "counting")!;
    Assert(!alarm.Visible && alarm.AlarmSchedule is null, "New alarm is enabled");
    var schedule = board.ScheduleAlarm(alarm.Id, new(clock.Now.AddMinutes(1)))!.AlarmSchedule;
    var edited = board.Update(alarm.Id, Patch(text: "終了") with { CountdownText = "カウント中" })!;
    Equal("終了", edited.Text);
    Equal("カウント中", edited.CountdownText);
    Equal(schedule, edited.AlarmSchedule);
    Equal(schedule, board.Update(alarm.Id, Patch() with { Visible = true })!.AlarmSchedule);
});

Run("Hiding an alarm disarms it before and after its deadline", () =>
{
    foreach (var elapsed in new[] { 5, 10, 15 })
    {
        var clock = new ManualTimeProvider();
        var board = new BoardStore(clock);
        var id = board.Add("alarm")!.Id;
        var schedule = board.ScheduleAlarm(id, new(clock.Now.AddSeconds(10)))!.AlarmSchedule!;
        clock.Now += TimeSpan.FromSeconds(elapsed);
        var hidden = board.Update(id, Patch() with { Visible = false })!;
        Assert(!hidden.Visible && hidden.AlarmSchedule is null && hidden.DisplaySchedule is null, "Hidden alarm is still armed");
        clock.Now += TimeSpan.FromMinutes(1);
        Equal(hidden, board.Snapshot().Elements.Single());
        Assert(!board.CancelAlarm(id, schedule.Id), "Canceled deadline is still active");
    }
});

Run("Restarting counting or finished alarms replaces the deadline and rejects stale stop actions", () =>
{
    foreach (var elapsed in new[] { 5, 15 })
    {
        var clock = new ManualTimeProvider();
        var board = new BoardStore(clock);
        var id = board.Add("alarm")!.Id;
        var old = board.ScheduleAlarm(id, new(clock.Now.AddSeconds(10)))!.AlarmSchedule!;
        clock.Now += TimeSpan.FromSeconds(elapsed);
        var restarted = board.ScheduleAlarm(id, new(clock.Now.AddMinutes(1)))!;
        Assert(restarted.Visible && restarted.AlarmSchedule!.Id != old.Id, "Alarm did not restart");
        Equal(clock.Now.AddMinutes(1), restarted.AlarmSchedule!.At);
        var revision = board.Snapshot().Revision;
        Assert(!board.CancelAlarm(id, old.Id), "Stale action stopped the restarted alarm");
        Equal(revision, board.Snapshot().Revision);
        Equal(restarted, board.Snapshot().Elements.Single());
    }
});

Run("Every successful element update publishes exactly one matching snapshot", () =>
{
    var clock = new ManualTimeProvider();
    var board = new BoardStore(clock);
    var text = board.Add("text")!;
    var script = board.Add("script", text: "script")!;
    var alarm = board.Add("alarm")!;
    var image = board.Add("image", new("GIF89a"u8.ToArray(), "image/gif"))!;
    var subscription = board.Subscribe();
    subscription.Reader.TryRead(out _);
    Check(() => board.Update(text.Id, Patch(text: "updated")));
    Check(() => board.ReplaceImage(image.Id, new([255, 216, 255], "image/jpeg")));
    Check(() => board.ControlScript(script.Id, new("play", null)));
    var scheduled = Check(() => board.ScheduleDisplay(script.Id, 10));
    Check(() => board.CancelDisplay(script.Id, scheduled.DisplaySchedule!.Id)
        ? board.Snapshot().Elements.Single(element => element.Id == script.Id) : null);
    var scheduledAlarm = Check(() => board.ScheduleDisplay(alarm.Id, 10, clock.Now.AddMinutes(1)));
    Check(() => board.CancelDisplay(alarm.Id, scheduledAlarm.DisplaySchedule!.Id)
        ? board.Snapshot().Elements.Single(element => element.Id == alarm.Id) : null);
    var startedAlarm = Check(() => board.ScheduleAlarm(alarm.Id, new(clock.Now.AddMinutes(1))));
    Check(() => board.CancelAlarm(alarm.Id, startedAlarm.AlarmSchedule!.Id)
        ? board.Snapshot().Elements.Single(element => element.Id == alarm.Id) : null);
    board.Unsubscribe(subscription.Id);

    Element Check(Func<Element?> update)
    {
        var revision = board.Snapshot().Revision;
        var updated = update();
        Assert(updated is not null, "Update failed");
        Assert(subscription.Reader.TryRead(out var snapshot), "Missing update event");
        Equal(revision + 1, snapshot!.Revision);
        Equal(updated, snapshot.Elements.Single(element => element.Id == updated!.Id));
        Assert(!subscription.Reader.TryRead(out _), "Extra update event");
        return updated!;
    }
});

Run("Missing elements and wrong element kinds never change or publish board state", () =>
{
    var clock = new ManualTimeProvider();
    var board = new BoardStore(clock);
    var text = board.Add("text")!;
    var before = board.Snapshot();
    var subscription = board.Subscribe();
    subscription.Reader.TryRead(out _);
    var missing = Guid.NewGuid();
    Equal<Element?>(null, board.Update(missing, Patch(text: "ignored")));
    Equal<Element?>(null, board.ScheduleDisplay(missing, 10));
    Assert(!board.CancelDisplay(missing, Guid.NewGuid()), "Missing element accepted cancellation");
    Assert(!board.CancelDisplay(text.Id, Guid.NewGuid()), "Unscheduled element accepted cancellation");
    foreach (var id in new[] { missing, text.Id })
    {
        Equal<Element?>(null, board.ReplaceImage(id, new("GIF89a"u8.ToArray(), "image/gif")));
        Equal<Element?>(null, board.ControlScript(id, new("play", null)));
        Equal<Element?>(null, board.ScheduleAlarm(id, new(clock.Now.AddMinutes(1))));
        Assert(!board.CancelAlarm(id, Guid.NewGuid()), "Wrong element accepted alarm cancellation");
        Equal<ImageData?>(null, board.GetImage(id));
    }
    var after = board.Snapshot();
    Equal(before.Revision, after.Revision);
    Assert(before.Elements.SequenceEqual(after.Elements), "Rejected update changed elements");
    Assert(!subscription.Reader.TryRead(out _), "Rejected update published an event");
    board.Unsubscribe(subscription.Id);
});

Run("Manual display and text changes preserve scheduled playback rules", () =>
{
    var clock = new ManualTimeProvider();
    var board = new BoardStore(clock);
    var id = board.Add("script", text: "original")!.Id;
    board.ControlScript(id, new("play", null));
    clock.Now += TimeSpan.FromSeconds(2);
    board.ScheduleDisplay(id, 10);
    var shown = board.Update(id, Patch() with { Visible = true })!;
    Equal<DisplaySchedule?>(null, shown.DisplaySchedule);
    Equal<DateTimeOffset?>(clock.Now, shown.Playback!.StartedAt);
    Equal(60, shown.Playback.Offset);
    board.ScheduleDisplay(id, 10);
    var hidden = board.Update(id, Patch() with { Visible = false })!;
    Equal<DisplaySchedule?>(null, hidden.DisplaySchedule);
    Equal<DateTimeOffset?>(null, hidden.Playback!.StartedAt);
    Equal(60, hidden.Playback.Offset);
    board.ControlScript(id, new("play", null));
    var schedule = board.ScheduleDisplay(id, 10)!.DisplaySchedule;
    var edited = board.Update(id, Patch(text: "replacement"))!;
    Equal(schedule, edited.DisplaySchedule);
    Equal(new ScriptPlayback(), edited.Playback);
});

Run("Concurrent image replacements retain every revision and the latest published snapshot", () =>
{
    var board = new BoardStore();
    var id = board.Add("image", new("GIF89a"u8.ToArray(), "image/gif"))!.Id;
    var subscription = board.Subscribe();
    subscription.Reader.TryRead(out _);
    Parallel.For(0, 100, index => board.ReplaceImage(id, new([255, 216, 255, (byte)index], "image/jpeg")));
    var snapshot = board.Snapshot();
    Equal(100L, snapshot.Elements.Single().ImageRevision);
    Equal(101L, snapshot.Revision);
    Equal("image/jpeg", board.GetImage(id)!.ContentType);
    Assert(subscription.Reader.TryRead(out var published), "Missing latest image update");
    Equal(snapshot.Revision, published!.Revision);
    Equal(snapshot.Elements.Single(), published.Elements.Single());
    board.Unsubscribe(subscription.Id);
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
