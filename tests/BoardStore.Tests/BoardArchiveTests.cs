using System.IO.Compression;
using System.Text;
using System.Text.Json.Nodes;
using ILINTEA;

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
            var time = source.Add("clock")!;
            source.Update(time.Id, new(null, null, null, null, null, null, null, null, null,
                ClockHourFormat: 12, ClockShowSeconds: false));
            var image = source.Add("image", new(ImageFixtures.Png, "image/png"))!;
            source.ReplaceImage(image.Id, new(ImageFixtures.Jpeg, "image/jpeg"));
            source.Update(image.Id, new(source.Snapshot().Canvas.Width - 135.1,
                source.Snapshot().Canvas.Height - 320.1, 135.1, 320.1, null, null, null, null, null));
            var script = source.Add("script", text: "原稿\nline 2")!;
            source.ControlScript(script.Id, new("speed", 75));
            source.ControlScript(script.Id, new("play", null));
            source.ScheduleDisplay(script.Id, 10);
            var alarm = source.Add("alarm", text: "終了 🌟", countdownText: "カウント中\nremaining")!;
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
                    Id = actual.Id, ImageRevision = 0, DisplaySchedule = null, AlarmSchedule = null,
                    Visible = expected.Kind is "script" or "alarm" ? false : expected.Visible,
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

        await Run("Scripts cleared to empty or whitespace round-trip without losing the rest of the board", async () =>
        {
            foreach (var blank in new[] { "", " \t\r\n" })
            {
                var source = new BoardStore();
                source.UpdateCanvas(new("4:3", "#123456"));
                var text = source.Add("text")!;
                source.Update(text.Id, new(null, null, null, null, "Keep this text", null, null, null, true));
                var script = source.Add("script", text: "Original script")!;
                source.ControlScript(script.Id, new("speed", 75));
                source.Update(script.Id, new(null, null, null, null, blank, null, null, null, true));
                var original = source.Snapshot();
                var target = new BoardStore();
                target.Add("clock");
                using var archive = new MemoryStream(await SaveAsync(source));
                var restored = await BoardArchive.RestoreAsync(archive, target);
                Equal(original.Canvas, restored.Canvas);
                Equal(original.Elements.Length, restored.Elements.Length);
                for (var i = 0; i < original.Elements.Length; i++)
                    Equal(original.Elements[i] with { Id = restored.Elements[i].Id }, restored.Elements[i]);
                Assert(original.Elements.SequenceEqual(source.Snapshot().Elements), "Saving changed the live board");
            }
        });

        await Run("Screen highlights are not saved or restored and saving leaves the live highlight unchanged", async () =>
        {
            var clock = new ManualTimeProvider();
            var source = new BoardStore(clock);
            source.Add("text");
            var live = source.HighlightScreen();
            var bytes = await SaveAsync(source);
            using (var zip = new ZipArchive(new MemoryStream(bytes), ZipArchiveMode.Read))
            using (var reader = new StreamReader(zip.GetEntry("settings.json")!.Open()))
                Assert(!JsonNode.Parse(await reader.ReadToEndAsync())!.AsObject().ContainsKey("highlight"),
                    "Archive contains a transient highlight");
            Equal(live.Highlight, source.Snapshot().Highlight);
            Equal(live.Revision, source.Snapshot().Revision);
            var target = new BoardStore(clock);
            target.HighlightScreen();
            using var archive = new MemoryStream(bytes);
            var restored = await BoardArchive.RestoreAsync(archive, target);
            Equal<ScreenHighlight?>(null, restored.Highlight);
            Equal<ScreenHighlight?>(null, target.Snapshot().Highlight);
        });

        // A fixed fixture protects the current contract independently of the exporter.
        const string version2 = """
            {
              "format": "ILINTEA", "version": 2,
              "canvas": {},
              "elements": [{
                "id": "8e271f90-573e-470e-b3c2-e43dfe39cacf", "kind": "text",
                "x": 10, "y": 20, "width": 200, "height": 100
              }]
            }
            """;
        await Run("Current settings files use defaults for omitted optional fields", async () =>
        {
            var target = new BoardStore();
            using var archive = new MemoryStream(CreateArchive(version2));
            var restored = await BoardArchive.RestoreAsync(archive, target);
            Equal(new CanvasSettings(), restored.Canvas);
            var element = restored.Elements.Single();
            Equal("", element.Text);
            Equal(64, element.FontSize);
            Equal("#ffffff", element.Color);
            Equal("left", element.Align);
            Assert(!element.Visible && element.CountdownText == "", "Optional fields lost their defaults");
        });

        await Run("Extra JSON fields and archive entries are ignored", async () =>
        {
            var json = JsonNode.Parse(version2)!.AsObject();
            json["futureSetting"] = new JsonObject { ["enabled"] = true };
            json["elements"]![0]!["futureElementSetting"] = "value";
            using var archive = new MemoryStream(CreateArchive(json.ToJsonString(), "../unused.txt", "ignored"u8.ToArray()));
            Equal(1, (await BoardArchive.RestoreAsync(archive, new BoardStore())).Elements.Length);
        });

        await Run("Older clock settings retain 24-hour display with seconds", async () =>
        {
            var json = JsonNode.Parse(version2)!.AsObject();
            json["elements"]![0]!["kind"] = "clock";
            using var archive = new MemoryStream(CreateArchive(json.ToJsonString()));
            var element = (await BoardArchive.RestoreAsync(archive, new BoardStore())).Elements.Single();
            Equal(24, element.ClockHourFormat);
            Assert(element.ClockShowSeconds, "Older clock settings lost their seconds");
        });

        await Run("Saving a counting alarm preserves both messages without changing the live alarm", async () =>
        {
            var clock = new ManualTimeProvider();
            var source = new BoardStore(clock);
            var id = source.Add("alarm", text: "finished", countdownText: "counting")!.Id;
            source.ScheduleAlarm(id, new(clock.Now.AddMinutes(1)));
            var original = source.Snapshot();
            using var archive = new MemoryStream(await SaveAsync(source));
            var restored = (await BoardArchive.RestoreAsync(archive, new BoardStore(clock))).Elements.Single();
            Assert(!restored.Visible && restored.AlarmSchedule is null && restored.DisplaySchedule is null, "Restored alarm is armed");
            Equal("counting", restored.CountdownText);
            Equal("finished", restored.Text);
            Equal(original.Revision, source.Snapshot().Revision);
            Equal(original.Elements.Single(), source.Snapshot().Elements.Single());
        });

        await Run("A delayed alarm restores hidden with both schedules cleared without altering the live board", async () =>
        {
            var clock = new ManualTimeProvider();
            var source = new BoardStore(clock);
            var id = source.Add("alarm", text: "finished", countdownText: "counting")!.Id;
            source.ScheduleDisplay(id, 10, clock.Now.AddMinutes(1));
            var original = source.Snapshot();
            using var archive = new MemoryStream(await SaveAsync(source));
            var restored = (await BoardArchive.RestoreAsync(archive, new BoardStore(clock))).Elements.Single();
            Assert(!restored.Visible && restored.DisplaySchedule is null && restored.AlarmSchedule is null,
                "Restored alarm retained a schedule");
            Equal("counting", restored.CountdownText);
            Equal("finished", restored.Text);
            Equal(original.Revision, source.Snapshot().Revision);
            Equal(original.Elements.Single(), source.Snapshot().Elements.Single());
        });

        await Run("Restoring even a visible alarm in the manifest leaves it disarmed", async () =>
        {
            var json = JsonNode.Parse(version2)!.AsObject();
            json["elements"]![0]!["kind"] = "alarm";
            json["elements"]![0]!["visible"] = true;
            json["elements"]![0]!["text"] = "finished";
            json["elements"]![0]!["countdownText"] = "counting";
            using var archive = new MemoryStream(CreateArchive(json.ToJsonString()));
            var element = (await BoardArchive.RestoreAsync(archive, new BoardStore())).Elements.Single();
            Assert(!element.Visible && element.AlarmSchedule is null && element.DisplaySchedule is null, "Restored alarm is enabled");
            Equal("finished", element.Text);
            Equal("counting", element.CountdownText);
        });

        await Run("Unsupported versions are rejected without changing the board", async () =>
        {
            foreach (var version in new[] { 0, 1, 3, int.MaxValue })
            {
                var json = JsonNode.Parse(version2)!.AsObject();
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
                json => json["elements"]![0]!["countdownText"] = null,
                json => json["elements"]![0]!["width"] = -1,
                json => json["elements"]![0]!["x"] = 9000,
                json => json["elements"]![0]!["color"] = "#123456\n",
                json => json["elements"]![0]!["scriptSpeed"] = 201,
                json => json["elements"]![0]!["clockHourFormat"] = 13,
                json => json["elements"]![0]!["clockShowSeconds"] = "false"
            ];
            foreach (var corrupt in corruptions)
            {
                var json = JsonNode.Parse(version2)!.AsObject();
                corrupt(json);
                await RejectUnchangedAsync(CreateArchive(json.ToJsonString()), "errors.settingsFileFormat");
            }
        });

        await Run("Missing and corrupt image entries are rejected before replacing any settings", async () =>
        {
            var json = JsonNode.Parse(version2)!.AsObject();
            json["elements"]![0]!["kind"] = "image";
            await RejectUnchangedAsync(CreateArchive(json.ToJsonString()), "errors.settingsFileFormat");
            var name = "images/8e271f90573e470eb3c2e43dfe39cacf";
            await RejectUnchangedAsync(CreateArchive(json.ToJsonString(), name, "invalid"u8.ToArray()), "errors.settingsFileFormat");
            foreach (var (_, bytes) in ImageFixtures.All)
                await RejectUnchangedAsync(CreateArchive(json.ToJsonString(), name, bytes[..8]), "errors.settingsFileFormat");
            await RejectUnchangedAsync(CreateArchive(json.ToJsonString(), name, []), "errors.settingsFileSize");
        });

        await Run("Malformed ZIP, JSON and duplicate manifests leave existing settings intact", async () =>
        {
            await RejectUnchangedAsync("not a zip"u8.ToArray(), "errors.settingsFileFormat");
            await RejectUnchangedAsync(CreateArchive("{"), "errors.settingsFileFormat");
            await RejectUnchangedAsync(CreateArchive("null"), "errors.settingsFileFormat");
            await RejectUnchangedAsync(CreateArchive(version2, "settings.json", Encoding.UTF8.GetBytes(version2)), "errors.settingsFileFormat");
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
            using var archive = new MemoryStream(CreateArchive(version2));
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
