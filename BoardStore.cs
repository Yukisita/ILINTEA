using System.Threading.Channels;

namespace StreamPrompter;

// One in-memory board: property patches are serialized so editing text does not overwrite another user's placement.
public sealed class BoardStore(TimeProvider? timeProvider = null)
{
    public const int MaxElements = 20;
    private readonly TimeProvider clock = timeProvider ?? TimeProvider.System;
    private readonly object gate = new();
    private readonly List<Element> elements = [];
    private readonly Dictionary<Guid, ImageData> images = [];
    private readonly Dictionary<Guid, Channel<BoardSnapshot>> subscribers = [];
    private long revision;
    private CanvasSettings canvas = new();

    public BoardSnapshot Snapshot()
    {
        lock (gate) return SnapshotCore();
    }

    internal BoardBackupState CaptureBackup()
    {
        lock (gate)
        {
            var now = clock.GetUtcNow();
            return new(canvas, elements.Select(element => element with
            {
                Visible = element.Kind != "alarm" && element.Visible &&
                    (element.DisplaySchedule is null || element.DisplaySchedule.At <= now),
                DisplaySchedule = null,
                AlarmSchedule = null
            }).ToArray(), new(images));
        }
    }

    internal BoardSnapshot RestoreBackup(BoardBackupState backup)
    {
        // Fresh IDs isolate restored elements from stale edits and cached images in other clients.
        var restored = backup.Elements.Select(element => (Original: element, Id: Guid.NewGuid())).ToArray();
        var restoredImages = restored.Where(item => item.Original.Kind == "image")
            .ToDictionary(item => item.Id, item => backup.Images[item.Original.Id]);
        lock (gate)
        {
            canvas = backup.Canvas;
            elements.Clear();
            elements.AddRange(restored.Select(item => item.Original with { Id = item.Id }));
            images.Clear();
            foreach (var image in restoredImages) images.Add(image.Key, image.Value);
            Publish();
            return SnapshotCore();
        }
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

    public Element? Add(string kind, ImageData? image = null, string? text = null, string? countdownText = null)
    {
        lock (gate)
        {
            if (elements.Count >= MaxElements) return null;
            var element = (kind switch
            {
                "clock" => new Element(Guid.NewGuid(), kind, 880, 24, 368, 88, Align: "right"),
                "image" => new Element(Guid.NewGuid(), kind, 80, 440, 240, 180),
                "script" => new Element(Guid.NewGuid(), kind, 80, 140, 1120, 420, text ?? "", 48, Playback: new()),
                "alarm" => new Element(Guid.NewGuid(), kind, 80, 520, 960, 160,
                    text ?? "", 40, "#332701", CountdownText: countdownText ?? ""),
                _ => new Element(Guid.NewGuid(), kind, 80, 120, 900, 180, "", 56)
            }) with { Visible = false };
            element = ScaleElement(element, canvas.Width / 1280, canvas.Height / 720);
            elements.Insert(0, element);
            if (image is not null) images.Add(element.Id, image);
            Publish();
            return element;
        }
    }

    public Element? Update(Guid id, ElementPatch patch) =>
        UpdateElement(id, current =>
        {
            var now = clock.GetUtcNow();
            var playback = current.Playback;
            if (patch.Visible is not null && current.DisplaySchedule?.At > now && playback?.StartedAt is not null)
                playback = playback with { Offset = playback.PositionAt(now), StartedAt = patch.Visible.Value ? now : null };
            if (patch.Text is not null && patch.Text != current.Text && playback is not null)
                playback = playback with { Offset = 0, StartedAt = null };
            return ClampElementBounds(current with
            {
                X = patch.X ?? current.X,
                Y = patch.Y ?? current.Y,
                Width = patch.Width ?? current.Width,
                Height = patch.Height ?? current.Height,
                Text = patch.Text ?? current.Text,
                FontSize = patch.FontSize ?? current.FontSize,
                Color = patch.Color ?? current.Color,
                Align = patch.Align ?? current.Align,
                Visible = patch.Visible ?? current.Visible,
                CountdownText = patch.CountdownText ?? current.CountdownText,
                Playback = playback,
                // Showing an alarm must retain its deadline; hiding it disarms it immediately.
                DisplaySchedule = patch.Visible is not null ? null : current.DisplaySchedule,
                AlarmSchedule = patch.Visible is false ? null : current.AlarmSchedule
            });
        });

    public BoardSnapshot? Move(Guid id, int offset)
    {
        lock (gate)
        {
            if (offset is not (-1 or 1)) return null;
            var index = elements.FindIndex(element => element.Id == id);
            if (index < 0) return null;
            var target = Math.Clamp(index + offset, 0, elements.Count - 1);
            if (target != index)
            {
                var element = elements[index];
                elements.RemoveAt(index);
                elements.Insert(target, element);
                Publish();
            }
            return SnapshotCore();
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

    public Element? ReplaceImage(Guid id, ImageData image) =>
        UpdateElement(id, element =>
        {
            images[id] = image;
            return element with { ImageRevision = element.ImageRevision + 1 };
        }, kind: "image");

    public Element? ControlScript(Guid id, ScriptControl control) =>
        UpdateElement(id, element =>
        {
            var playback = element.Playback!;
            var now = clock.GetUtcNow();
            var position = playback.PositionAt(now);
            var start = element.DisplaySchedule?.At > now ? element.DisplaySchedule.At : now;
            playback = control.Action switch
            {
                "play" => playback with { StartedAt = playback.StartedAt ?? start },
                "pause" => playback with { Offset = position, StartedAt = null },
                "reset" => playback with { Offset = 0, StartedAt = null },
                "speed" => playback with { Speed = control.Speed!.Value, Offset = position, StartedAt = playback.StartedAt is null ? null : start },
                _ => playback
            };
            return element with { Playback = playback };
        }, kind: "script");

    public Element? ScheduleDisplay(Guid id, int delaySeconds, DateTimeOffset? alarmAt = null) =>
        UpdateElement(id, element =>
        {
            var now = clock.GetUtcNow();
            if (delaySeconds is < 1 or > 86400 ||
                (element.Kind == "alarm" && (alarmAt is null || alarmAt <= now))) return null;
            var schedule = new DisplaySchedule(Guid.NewGuid(), now.AddSeconds(delaySeconds));
            var playback = element.Playback;
            if (playback?.StartedAt is not null)
                playback = playback with { Offset = playback.PositionAt(now), StartedAt = schedule.At };
            // Reserve display and the alarm deadline together, without briefly putting the alarm on air.
            return element with
            {
                Visible = true, DisplaySchedule = schedule, Playback = playback,
                AlarmSchedule = element.Kind == "alarm"
                    ? new(Guid.NewGuid(), alarmAt!.Value.ToUniversalTime()) : element.AlarmSchedule
            };
        });

    public bool CancelDisplay(Guid id, Guid scheduleId) =>
        UpdateElement(id, element =>
        {
            var now = clock.GetUtcNow();
            if (element.DisplaySchedule?.Id != scheduleId || element.DisplaySchedule.At <= now) return null;
            var playback = element.Playback;
            if (playback is not null) playback = playback with { Offset = playback.PositionAt(now), StartedAt = null };
            return element with { Visible = false, DisplaySchedule = null, AlarmSchedule = null, Playback = playback };
        }) is not null;

    public Element? ScheduleAlarm(Guid id, ScheduleAlarm request) =>
        UpdateElement(id, element =>
        {
            if (request.At <= clock.GetUtcNow()) return null;
            return element with
            {
                Visible = true,
                AlarmSchedule = new(Guid.NewGuid(), request.At.ToUniversalTime())
            };
        }, kind: "alarm");

    public bool CancelAlarm(Guid id, Guid scheduleId) =>
        UpdateElement(id, element => element.AlarmSchedule?.Id != scheduleId ? null : element with
        {
            Visible = false, DisplaySchedule = null, AlarmSchedule = null
        }, kind: "alarm") is not null;

    // Lookup, mutation and publication share one lock; rejected updates publish nothing.
    private Element? UpdateElement(Guid id, Func<Element, Element?> update, string? kind = null)
    {
        lock (gate)
        {
            var index = elements.FindIndex(element => element.Id == id && (kind is null || element.Kind == kind));
            if (index < 0) return null;
            var updated = update(elements[index]);
            if (updated is null) return null;
            elements[index] = updated;
            Publish();
            return updated;
        }
    }

    public CanvasSettings UpdateCanvas(CanvasPatch patch)
    {
        lock (gate)
        {
            var updated = canvas with
            {
                AspectRatio = patch.AspectRatio ?? canvas.AspectRatio,
                BackgroundColor = patch.BackgroundColor ?? canvas.BackgroundColor
            };
            if (updated == canvas) return canvas;
            var scaleX = updated.Width / canvas.Width;
            var scaleY = updated.Height / canvas.Height;
            canvas = updated;
            if (scaleX != 1 || scaleY != 1)
                for (var i = 0; i < elements.Count; i++) elements[i] = ScaleElement(elements[i], scaleX, scaleY);
            Publish();
            return canvas;
        }
    }

    private Element ScaleElement(Element element, double scaleX, double scaleY) => ClampElementBounds(element with
    {
        X = element.X * scaleX,
        Y = element.Y * scaleY,
        Width = element.Width * scaleX,
        Height = element.Height * scaleY
    });

    private Element ClampElementBounds(Element element)
    {
        var width = Math.Clamp(element.Width, 80, canvas.Width);
        var height = Math.Clamp(element.Height, 48, canvas.Height);
        return element with
        {
            X = Math.Clamp(element.X, 0, canvas.Width - width),
            Y = Math.Clamp(element.Y, 0, canvas.Height - height),
            Width = width, Height = height
        };
    }

    private BoardSnapshot SnapshotCore() => new(revision, clock.GetUtcNow().ToUnixTimeMilliseconds(), elements.ToArray(), canvas);

    private void Publish()
    {
        revision++;
        var snapshot = SnapshotCore();
        foreach (var channel in subscribers.Values) channel.Writer.TryWrite(snapshot);
    }
}
