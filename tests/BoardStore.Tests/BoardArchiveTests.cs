using System.IO.Compression;
using System.Text;
using System.Text.Json.Nodes;
using StreamPrompter;

internal static class BoardArchiveTests
{
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        await Run("Archives round-trip canvas, layer order, every element kind and original image bytes", async () =>
        {
            var clock = new ManualTimeProvider();
            var source = new BoardStore(clock);
            source.UpdateCanvas(new("9:16", "#123456"));
            var text = source.Add("text")!;
            source.Update(text.Id, new(45, 90, 500, 150, "保存\n\"text\" 🌟", 80, "#abcdef", "center", true));
            source.Add("clock");
            var image = source.Add("image", new([137, 80, 78, 71, 13, 10, 26, 10, 1], "image/png"))!;
            source.ReplaceImage(image.Id, new([255, 216, 255, 42], "image/jpeg"));
            source.Update(image.Id, new(source.Snapshot().Canvas.Width - 135.1,
                source.Snapshot().Canvas.Height - 320.1, 135.1, 320.1, null, null, null, null, null));
            var script = source.Add("script", text: "原稿\nline 2")!;
            source.ControlScript(script.Id, new("speed", 75));
            source.ControlScript(script.Id, new("play", null));
            source.ScheduleDisplay(script.Id, 10);
            var alarm = source.Add("alarm", text: "alarm message")!;
            source.Update(alarm.Id, new(null, null, null, null, null, null, null, null, null, true));
            source.ScheduleAlarm(alarm.Id, new(clock.Now.AddSeconds(1)));
            clock.Now += TimeSpan.FromSeconds(2);
            var original = source.Snapshot();
            var target = new BoardStore(clock);
            var old = target.Add("image", new("GIF89a"u8.ToArray(), "image/gif"))!;
            var subscription = target.Subscribe();
            subscription.Reader.TryRead(out _);
            var revision = target.Snapshot().Revision;
            using var archive = new MemoryStream(await SaveAsync(source));
            var restored = await BoardArchive.RestoreAsync(archive, target);
            Equal(original.Canvas, restored.Canvas);
            Equal(revision + 1, restored.Revision);
            Equal(original.Elements.Length, restored.Elements.Length);
            for (var i = 0; i < original.Elements.Length; i++)
            {
                var expected = original.Elements[i];
                var actual = restored.Elements[i];
                Assert(!original.Elements.Any(element => element.Id == actual.Id), "Element ID was reused");
                Equal(expected with
                {
                    Id = actual.Id, ImageRevision = 0, DisplaySchedule = null,
                    Visible = expected.Kind == "script" ? false : expected.Visible,
                    Playback = expected.Kind == "script" ? new(Speed: 75) : null
                }, actual);
                if (expected.Kind == "image")
                {
                    Equal("image/jpeg", target.GetImage(actual.Id)!.ContentType);
                    Assert(target.GetImage(actual.Id)!.Bytes.SequenceEqual(source.GetImage(expected.Id)!.Bytes), "Image bytes changed");
                }
            }
            Assert(target.GetImage(old.Id) is null && target.Update(text.Id,
                new(null, null, null, null, "stale", null, null, null, null)) is null, "Stale data affected restored elements");
            Assert(subscription.Reader.TryRead(out var notification) && notification.Revision == restored.Revision,
                "Restore did not notify subscribers");
            Assert(!subscription.Reader.TryRead(out _), "Restore produced extra events");
            target.Unsubscribe(subscription.Id);
        });

        // A fixed v1 fixture protects defaults independently of today's exporter.
        const string version1 = """
            {
              "format": "StreamPrompter", "version": 1,
              "canvas": {},
              "elements": [{
                "id": "8e271f90-573e-470e-b3c2-e43dfe39cacf", "kind": "text",
                "x": 10, "y": 20, "width": 200, "height": 100
              }]
            }
            """;
        await Run("Version 1 files retain defaults for omitted optional fields", async () =>
        {
            var target = new BoardStore();
            using var archive = new MemoryStream(CreateArchive(version1));
            var restored = await BoardArchive.RestoreAsync(archive, target);
            Equal(new CanvasSettings(), restored.Canvas);
            var element = restored.Elements.Single();
            Equal("", element.Text);
            Equal(64, element.FontSize);
            Equal("#ffffff", element.Color);
            Equal("left", element.Align);
            Assert(!element.Visible && !element.ShowCountdown, "Optional flags lost their defaults");
        });

        await Run("Compatible extra JSON fields and archive entries are ignored", async () =>
        {
            var json = JsonNode.Parse(version1)!.AsObject();
            json["futureSetting"] = new JsonObject { ["enabled"] = true };
            json["elements"]![0]!["futureElementSetting"] = "value";
            using var archive = new MemoryStream(CreateArchive(json.ToJsonString(), "../unused.txt", "ignored"u8.ToArray()));
            Equal(1, (await BoardArchive.RestoreAsync(archive, new BoardStore())).Elements.Length);
        });

        await Run("Unsupported versions are rejected without changing the board", async () =>
        {
            foreach (var version in new[] { 0, 2, int.MaxValue })
            {
                var json = JsonNode.Parse(version1)!.AsObject();
                json["version"] = version;
                await RejectUnchangedAsync(CreateArchive(json.ToJsonString()), "errors.settingsFileVersion");
            }
        });

        await Run("Invalid settings never partially overwrite the current board", async () =>
        {
            Action<JsonObject>[] corruptions = [
                json => json["format"] = "another-app",
                json => json["canvas"] = null,
                json => json["canvas"]!["aspectRatio"] = "invalid",
                json => json["canvas"]!["backgroundColor"] = "#fff",
                json => json["elements"] = null,
                json => json["elements"]!.AsArray().Add(json["elements"]![0]!.DeepClone()),
                json => json["elements"] = new JsonArray(Enumerable.Range(0, 21)
                    .Select(_ => json["elements"]![0]!.DeepClone()).ToArray()),
                json => json["elements"]![0] = null,
                json => json["elements"]![0]!["kind"] = "unknown",
                json => json["elements"]![0]!["text"] = null,
                json => json["elements"]![0]!["width"] = -1,
                json => json["elements"]![0]!["x"] = 9000,
                json => json["elements"]![0]!["color"] = "#123456\n",
                json => json["elements"]![0]!["scriptSpeed"] = 201,
                json => json["elements"]![0]!["kind"] = "script"
            ];
            foreach (var corrupt in corruptions)
            {
                var json = JsonNode.Parse(version1)!.AsObject();
                corrupt(json);
                await RejectUnchangedAsync(CreateArchive(json.ToJsonString()), "errors.settingsFileFormat");
            }
        });

        await Run("Missing and corrupt image entries are rejected before replacing any settings", async () =>
        {
            var json = JsonNode.Parse(version1)!.AsObject();
            json["elements"]![0]!["kind"] = "image";
            await RejectUnchangedAsync(CreateArchive(json.ToJsonString()), "errors.settingsFileFormat");
            var name = "images/8e271f90573e470eb3c2e43dfe39cacf";
            await RejectUnchangedAsync(CreateArchive(json.ToJsonString(), name, "invalid"u8.ToArray()), "errors.settingsFileFormat");
            await RejectUnchangedAsync(CreateArchive(json.ToJsonString(), name, []), "errors.settingsFileSize");
        });

        await Run("Malformed ZIP, JSON and duplicate manifests leave existing settings intact", async () =>
        {
            await RejectUnchangedAsync("not a zip"u8.ToArray(), "errors.settingsFileFormat");
            await RejectUnchangedAsync(CreateArchive("{"), "errors.settingsFileFormat");
            await RejectUnchangedAsync(CreateArchive("null"), "errors.settingsFileFormat");
            await RejectUnchangedAsync(CreateArchive(version1, "settings.json", Encoding.UTF8.GetBytes(version1)), "errors.settingsFileFormat");
        });

        await Run("Empty boards can be saved and restored", async () =>
        {
            var target = new BoardStore();
            target.Add("text");
            using var archive = new MemoryStream(await SaveAsync(new BoardStore()));
            var restored = await BoardArchive.RestoreAsync(archive, target);
            Equal(0, restored.Elements.Length);
            Equal(new CanvasSettings(), restored.Canvas);
        });

        await Run("Cancellation never applies partially read settings", async () =>
        {
            var target = new BoardStore(new ManualTimeProvider());
            target.Add("text");
            var before = target.Snapshot();
            using var archive = new MemoryStream(CreateArchive(version1));
            using var cancellation = new CancellationTokenSource();
            cancellation.Cancel();
            try
            {
                await BoardArchive.RestoreAsync(archive, target, cancellation.Token);
                throw new InvalidOperationException("Canceled restore succeeded");
            }
            catch (OperationCanceledException) { }
            AssertUnchanged(before, target.Snapshot());
        });

        return passed;

        async Task Run(string name, Func<Task> test)
        {
            await test();
            passed++;
            Console.WriteLine($"PASS: {name}");
        }
    }

    private static async Task<byte[]> SaveAsync(BoardStore board)
    {
        using var stream = new MemoryStream();
        await BoardArchive.WriteAsync(stream, board);
        return stream.ToArray();
    }

    private static byte[] CreateArchive(string json, string? extraName = null, byte[]? extraBytes = null)
    {
        using var stream = new MemoryStream();
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        {
            using (var writer = new StreamWriter(archive.CreateEntry("settings.json").Open(), new UTF8Encoding(false)))
                writer.Write(json);
            if (extraName is not null)
            {
                using var entry = archive.CreateEntry(extraName).Open();
                entry.Write(extraBytes!);
            }
        }
        return stream.ToArray();
    }

    private static async Task RejectUnchangedAsync(byte[] bytes, string errorKey)
    {
        var target = new BoardStore(new ManualTimeProvider());
        var image = target.Add("image", new("GIF89a"u8.ToArray(), "image/gif"))!;
        target.UpdateCanvas(new("4:3", "#abcdef"));
        var before = target.Snapshot();
        var subscription = target.Subscribe();
        subscription.Reader.TryRead(out _);
        using var archive = new MemoryStream(bytes);
        try
        {
            await BoardArchive.RestoreAsync(archive, target);
            throw new InvalidOperationException("Invalid restore succeeded");
        }
        catch (BoardArchiveException exception) { Equal(errorKey, exception.ErrorKey); }
        AssertUnchanged(before, target.Snapshot());
        Assert(target.GetImage(image.Id)!.Bytes.SequenceEqual("GIF89a"u8.ToArray()), "Existing image changed");
        Assert(!subscription.Reader.TryRead(out _), "Failed restore published a state change");
        target.Unsubscribe(subscription.Id);
    }

    private static void AssertUnchanged(BoardSnapshot before, BoardSnapshot after)
    {
        Equal(before.Revision, after.Revision);
        Equal(before.Canvas, after.Canvas);
        Assert(before.Elements.SequenceEqual(after.Elements), "Existing elements changed");
    }

    private static void Equal<T>(T expected, T actual) =>
        Assert(EqualityComparer<T>.Default.Equals(expected, actual), $"Expected {expected}; actual {actual}");

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
