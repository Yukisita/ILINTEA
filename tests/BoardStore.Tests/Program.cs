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
