using System.Buffers.Binary;
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

        await Run("Edited scripts are separate UTF-8 files referenced from the version 1 manifest", async () =>
        {
            var source = new BoardStore();
            var caption = source.Add("text")!;
            source.Update(caption.Id, new(null, null, null, null, "Keep caption inline", null, null, null, null));
            var contents = new[] { "原稿\r\n\"quoted\" 🌟\t\0end", "", " \t\r\n", "\uFEFFLeading character" };
            foreach (var content in contents)
            {
                var script = source.Add("script", text: "Before editing")!;
                source.Update(script.Id, new(null, null, null, null, content, null, null, null, null));
            }
            var bytes = await SaveAsync(source);
            using (var zip = new ZipArchive(new MemoryStream(bytes), ZipArchiveMode.Read))
            {
                using var manifestReader = new StreamReader(zip.GetEntry("settings.json")!.Open());
                var manifest = JsonNode.Parse(await manifestReader.ReadToEndAsync())!;
                Equal(1, manifest["version"]!.GetValue<int>());
                foreach (var saved in manifest["elements"]!.AsArray())
                {
                    if (saved!["kind"]!.GetValue<string>() != "script")
                    {
                        Equal("Keep caption inline", saved["text"]!.GetValue<string>());
                        Assert(!saved.AsObject().ContainsKey("scriptFile"), "Caption references a script file");
                        continue;
                    }
                    Assert(!saved.AsObject().ContainsKey("text"), "Script body is still embedded in JSON");
                    var id = saved["id"]!.GetValue<Guid>();
                    var name = saved["scriptFile"]!.GetValue<string>();
                    Equal($"scripts/{id:N}.txt", name);
                    using var entry = zip.GetEntry(name)!.Open();
                    using var actual = new MemoryStream();
                    await entry.CopyToAsync(actual);
                    var expected = source.Snapshot().Elements.Single(element => element.Id == id).Text;
                    Assert(actual.ToArray().SequenceEqual(new UTF8Encoding(false, true).GetBytes(expected)),
                        "Saved script differs from edited contents");
                }
                Equal(contents.Length + 1, zip.Entries.Count);
            }
            using var archive = new MemoryStream(bytes);
            var restored = await BoardArchive.RestoreAsync(archive, new BoardStore());
            Assert(source.Snapshot().Elements.Select(element => element.Text)
                .SequenceEqual(restored.Elements.Select(element => element.Text)), "Script text changed during restore");
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
        const string currentManifest = """
            {
              "format": "ILINTEA", "version": 1,
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
            using var archive = new MemoryStream(CreateArchive(currentManifest));
            var restored = await BoardArchive.RestoreAsync(archive, target);
            Equal(new CanvasSettings(), restored.Canvas);
            var element = restored.Elements.Single();
            Equal("", element.Text);
            Equal(64, element.FontSize);
            Equal("#ffffff", element.Color);
            Equal("left", element.Align);
            Assert(!element.Visible && element.CountdownText == "", "Optional fields lost their defaults");
        });

        await Run("Twenty large scripts do not enlarge the JSON manifest with their contents", async () =>
        {
            var source = new BoardStore();
            var content = new string('あ', 64 * 1024) + "\n🌟";
            for (var index = 0; index < BoardStore.MaxElements; index++) source.Add("script", text: content);
            using var bytes = new MemoryStream(await SaveAsync(source));
            using (var zip = new ZipArchive(bytes, ZipArchiveMode.Read, leaveOpen: true))
            {
                Assert(zip.GetEntry("settings.json")!.Length < 20 * 1024, "Script contents enlarged the manifest");
                Equal(BoardStore.MaxElements, zip.Entries.Count(entry => entry.FullName.StartsWith("scripts/")));
            }
            bytes.Position = 0;
            var restored = await BoardArchive.RestoreAsync(bytes, new BoardStore());
            Equal(BoardStore.MaxElements, restored.Elements.Length);
            Assert(restored.Elements.All(element => element.Text == content), "Large script contents changed");
        });

        var scriptManifest = JsonNode.Parse(currentManifest)!.AsObject();
        scriptManifest["elements"]![0]!["kind"] = "script";
        const string scriptName = "scripts/8e271f90573e470eb3c2e43dfe39cacf.txt";
        scriptManifest["elements"]![0]!["scriptFile"] = scriptName;
        await Run("Missing, duplicate and invalid script files never replace the current board", async () =>
        {
            var json = scriptManifest.ToJsonString();
            await RejectUnchangedAsync(CreateArchive(json), "errors.settingsFileFormat");
            await RejectUnchangedAsync(CreateArchive(json,
                [(scriptName, "first"u8.ToArray()), (scriptName, "duplicate"u8.ToArray())]), "errors.settingsFileFormat");
            foreach (var invalid in new byte[][] { [0xc3, 0x28], [0xff, 0xfe, 0x61, 0x00], [0xe3, 0x81] })
                await RejectUnchangedAsync(CreateArchive(json, scriptName, invalid), "errors.settingsFileFormat");

            var second = scriptManifest.DeepClone();
            var missing = second["elements"]![0]!.DeepClone();
            var missingId = Guid.NewGuid();
            missing["id"] = missingId;
            missing["scriptFile"] = $"scripts/{missingId:N}.txt";
            second["elements"]!.AsArray().Add(missing);
            await RejectUnchangedAsync(CreateArchive(second.ToJsonString(), scriptName, "valid first script"u8.ToArray()),
                "errors.settingsFileFormat");
        });

        await Run("Script references must match the element ID and cannot conflict with inline contents", async () =>
        {
            Action<JsonNode>[] corruptions = [
                json => json["elements"]![0]!.AsObject().Remove("scriptFile"),
                json => json["elements"]![0]!["scriptFile"] = "../script.txt",
                json => json["elements"]![0]!["scriptFile"] = $"scripts/{Guid.NewGuid():N}.txt",
                json => json["elements"]![0]!["text"] = "conflicting body",
                json => json["elements"]![0]!["kind"] = "text"
            ];
            foreach (var corrupt in corruptions)
            {
                var json = scriptManifest.DeepClone();
                corrupt(json);
                await RejectUnchangedAsync(CreateArchive(json.ToJsonString(), scriptName, "body"u8.ToArray()),
                    "errors.settingsFileFormat");
            }
        });

        await Run("Script sizes are checked before allocation and against the actual decompressed bytes", async () =>
        {
            var json = scriptManifest.ToJsonString();
            var bytes = "test body"u8.ToArray();
            await RejectUnchangedAsync(WithEntryLength(CreateArchive(json, scriptName, bytes), scriptName,
                1024L * 1024 * 1024 + 1), "errors.settingsFileSize");
            await RejectUnchangedAsync(WithEntryLength(CreateArchive(json, scriptName, bytes,
                CompressionLevel.NoCompression), scriptName, 1), "errors.settingsFileSize");
            await RejectUnchangedAsync(WithEntryLength(CreateArchive(json, scriptName, bytes,
                CompressionLevel.NoCompression), scriptName, bytes.Length + 1), "errors.settingsFileFormat");
            // A permitted declared size must not cause an allocation of that size for a tiny entry.
            await RejectUnchangedAsync(WithEntryLength(CreateArchive(json, scriptName, bytes,
                CompressionLevel.NoCompression), scriptName, 1024L * 1024 * 1024), "errors.settingsFileFormat");
        });

        await Run("Extra JSON fields and archive entries are ignored", async () =>
        {
            var json = JsonNode.Parse(currentManifest)!.AsObject();
            json["futureSetting"] = new JsonObject { ["enabled"] = true };
            json["elements"]![0]!["futureElementSetting"] = "value";
            using var archive = new MemoryStream(CreateArchive(json.ToJsonString(), "../unused.txt", "ignored"u8.ToArray()));
            Equal(1, (await BoardArchive.RestoreAsync(archive, new BoardStore())).Elements.Length);
        });

        await Run("Manifest size checks use a separate 512 MiB limit before reading JSON", async () =>
        {
            Equal(536_870_912L, BoardArchive.MaxManifestBytes);
            Assert(BoardArchive.MaxArchiveBytes > BoardArchive.MaxManifestBytes, "ZIP limit includes image bytes");
            // Only metadata is enlarged; the actual payload remains one byte.
            foreach (var length in new[] { BoardArchive.MaxManifestBytes - 1, BoardArchive.MaxManifestBytes })
            {
                using var archive = new ArchiveReadStream(WithManifestLength(CreateArchive("{"), length));
                await RejectUnchangedAsync([], "errors.settingsFileFormat", archive);
                Assert(archive.EntryBytesRead > 0, "A manifest at the size limit was rejected before reading");
            }
            using var oversized = new ArchiveReadStream(WithManifestLength(CreateArchive("{"), BoardArchive.MaxManifestBytes + 1));
            await RejectUnchangedAsync([], "errors.settingsFileSize", oversized);
            Equal(0L, oversized.EntryBytesRead);
        });

        await Run("Understated ZIP lengths cannot bypass the decompressed byte limit", async () =>
        {
            await RejectUnchangedAsync(WithManifestLength(CreateArchive(currentManifest,
                compression: CompressionLevel.NoCompression), 16), "errors.settingsFileSize");
            // .NET's deflate reader independently rejects an inconsistent uncompressed size.
            await RejectUnchangedAsync(WithManifestLength(CreateArchive(currentManifest), 16), "errors.settingsFileFormat");
        });

        await Run("Twenty elements and long split tokens restore while nested future arrays are ignored", async () =>
        {
            var json = JsonNode.Parse(currentManifest)!.AsObject();
            var template = json["elements"]![0]!;
            json["elements"] = new JsonArray(Enumerable.Range(0, BoardStore.MaxElements).Select(_ =>
            {
                var element = template.DeepClone();
                element["id"] = Guid.NewGuid();
                return element;
            }).ToArray());
            var text = new string('あ', 12_000) + "\n\"split 🌟\"";
            json["elements"]![0]!["text"] = text;
            json["futureSetting"] = new JsonObject
            {
                ["elements"] = new JsonArray(Enumerable.Range(0, BoardStore.MaxElements + 1)
                    .Select(_ => JsonValue.Create("ignored")).ToArray())
            };
            using var archive = new MemoryStream(CreateArchive(json.ToJsonString()));
            var restored = await BoardArchive.RestoreAsync(archive, new BoardStore());
            Equal(BoardStore.MaxElements, restored.Elements.Length);
            Equal(text, restored.Elements[0].Text);
        });

        await Run("The twenty-first element is rejected before its large body is read", async () =>
        {
            var json = JsonNode.Parse(currentManifest)!.AsObject();
            var template = json["elements"]![0]!;
            json["elements"] = new JsonArray(Enumerable.Range(0, BoardStore.MaxElements + 1).Select(_ =>
            {
                var element = template.DeepClone();
                element["id"] = Guid.NewGuid();
                return element;
            }).ToArray());
            json["elements"]![BoardStore.MaxElements]!["text"] = new string('x', 128 * 1024);
            foreach (var name in new[] { "elements", "ElEmEnTs", "\\u0065lements" })
            {
                var document = json.ToJsonString().Replace("\"elements\"", $"\"{name}\"");
                using var archive = new ArchiveReadStream(CreateArchive(document, compression: CompressionLevel.NoCompression));
                await RejectUnchangedAsync([], "errors.settingsFileFormat", archive);
                Assert(archive.EntryBytesRead < 32 * 1024, "The excess element body was read before rejection");
            }
        });

        await Run("Streaming validation preserves UTF-8 BOM support across one-byte reads", async () =>
        {
            using var archive = new ArchiveReadStream(CreateArchive("\uFEFF" + currentManifest,
                compression: CompressionLevel.NoCompression), maxReadBytes: 1);
            Equal(1, (await BoardArchive.RestoreAsync(archive, new BoardStore())).Elements.Length);
        });

        await Run("Omitted clock settings default to 24-hour display with seconds", async () =>
        {
            var json = JsonNode.Parse(currentManifest)!.AsObject();
            json["elements"]![0]!["kind"] = "clock";
            using var archive = new MemoryStream(CreateArchive(json.ToJsonString()));
            var element = (await BoardArchive.RestoreAsync(archive, new BoardStore())).Elements.Single();
            Equal(24, element.ClockHourFormat);
            Assert(element.ClockShowSeconds, "Default clock settings lost their seconds");
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
            var json = JsonNode.Parse(currentManifest)!.AsObject();
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
            foreach (var version in new[] { -1, 0, BoardArchive.CurrentVersion + 1, int.MaxValue })
            {
                var json = JsonNode.Parse(currentManifest)!.AsObject();
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
                var json = JsonNode.Parse(currentManifest)!.AsObject();
                corrupt(json);
                await RejectUnchangedAsync(CreateArchive(json.ToJsonString()), "errors.settingsFileFormat");
            }
        });

        await Run("Missing and corrupt image entries are rejected before replacing any settings", async () =>
        {
            var json = JsonNode.Parse(currentManifest)!.AsObject();
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
            await RejectUnchangedAsync(CreateArchive("{\"\\uD800\":0}"), "errors.settingsFileFormat");
            await RejectUnchangedAsync(CreateArchive("{\"\\uDC00\":0}"), "errors.settingsFileFormat");
            await RejectUnchangedAsync(CreateArchive(currentManifest, "settings.json", Encoding.UTF8.GetBytes(currentManifest)), "errors.settingsFileFormat");
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
            using var archive = new MemoryStream(CreateArchive(currentManifest));
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

    private static byte[] CreateArchive(string json, string? extraName = null, byte[]? extraBytes = null,
        CompressionLevel compression = CompressionLevel.Optimal) =>
        CreateArchive(json, extraName is null ? [] : [(extraName, extraBytes!)], compression);

    private static byte[] CreateArchive(string json, (string Name, byte[] Bytes)[] extraEntries,
        CompressionLevel compression = CompressionLevel.Optimal)
    {
        using var stream = new MemoryStream();
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        {
            using (var writer = new StreamWriter(archive.CreateEntry("settings.json", compression).Open(), new UTF8Encoding(false)))
                writer.Write(json);
            foreach (var extra in extraEntries)
            {
                using var entry = archive.CreateEntry(extra.Name, compression).Open();
                entry.Write(extra.Bytes);
            }
        }
        return stream.ToArray();
    }

    private static byte[] WithManifestLength(byte[] bytes, long length) => WithEntryLength(bytes, "settings.json", length);

    private static byte[] WithEntryLength(byte[] bytes, string name, long length)
    {
        var directory = checked((int)BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(bytes.Length - 22 + 16)));
        while (BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(directory)) == 0x02014b50u)
        {
            var nameLength = BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(directory + 28));
            if (Encoding.UTF8.GetString(bytes.AsSpan(directory + 46, nameLength)) == name)
            {
                var local = checked((int)BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(directory + 42)));
                BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(directory + 24), checked((uint)length));
                BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(local + 22), checked((uint)length));
                return bytes;
            }
            directory += 46 + nameLength + BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(directory + 30))
                + BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(directory + 32));
        }
        throw new InvalidOperationException($"Entry not found: {name}");
    }

    private sealed class ArchiveReadStream(byte[] bytes, int maxReadBytes = int.MaxValue) : MemoryStream(bytes)
    {
        private readonly byte[] data = bytes;
        private readonly long entryStart = 30 + BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(26))
            + BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(28));
        private readonly long entryLength = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(18));
        private bool readingEntry;
        public long EntryBytesRead { get; private set; }
        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));
        public override int Read(Span<byte> buffer)
        {
            var start = Position;
            var count = (int)Math.Min(Math.Min(buffer.Length, maxReadBytes), Math.Max(0, Length - start));
            data.AsSpan((int)Math.Min(start, Length), count).CopyTo(buffer);
            Position += count;
            if (start == entryStart) readingEntry = true;
            if (readingEntry)
                EntryBytesRead += Math.Max(0, Math.Min(start + count, entryStart + entryLength) - Math.Max(start, entryStart));
            return count;
        }
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.FromResult(Read(buffer.Span));
        }
    }

    private static async Task RejectUnchangedAsync(byte[] bytes, string errorKey, Stream? source = null)
    {
        var target = new BoardStore(new ManualTimeProvider());
        var image = target.Add("image", new("GIF89a"u8.ToArray(), "image/gif"))!;
        target.UpdateCanvas(new("4:3", "#abcdef"));
        var before = target.Snapshot();
        var subscription = target.Subscribe();
        subscription.Reader.TryRead(out _);
        using var archive = source ?? new MemoryStream(bytes);
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
