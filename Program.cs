using System.Net.Sockets;
using System.Text.Json;
using Microsoft.AspNetCore.Connections;
using Microsoft.AspNetCore.Http.Features;
using ILINTEA;

var starting = true;
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory,
    WebRootPath = "wwwroot"
});
builder.Configuration.AddIniFile("ILINTEA.ini", optional: false, reloadOnChange: false);
I18n.SetLanguage(builder.Configuration["I18n:Language"]);
if (!int.TryParse(builder.Configuration["Server:Port"], out var port) || port is < 1 or > 65535)
    throw new InvalidOperationException("Invalid [Server] Port in ILINTEA.ini. Expected 1-65535.");
builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
builder.Logging.ClearProviders();
builder.Logging.AddConsole();
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
builder.Logging.AddFilter("Microsoft.Hosting.Lifetime", LogLevel.Warning);
// Report expected port conflicts below; retain normal host diagnostics once running.
builder.Logging.AddFilter("Microsoft.Extensions.Hosting.Internal.Host",
    level => level >= LogLevel.Information && (!starting || level >= LogLevel.Critical));
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<BoardStore>();
builder.Services.Configure<FormOptions>(options => options.MultipartBodyLengthLimit = UploadLimits.MaxFileBytes);
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = UploadLimits.MaxRequestBodyBytes);
var app = builder.Build();
var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/board", (BoardStore board) => board.Snapshot());
app.MapPost("/api/highlight", (BoardStore board) => board.HighlightScreen());
app.MapDelete("/api/highlight/{id:guid}", (Guid id, BoardStore board) =>
{
    var snapshot = board.ClearHighlight(id);
    return snapshot is null ? Results.NotFound(I18n.Error("errors.highlightMissing")) : Results.Ok(snapshot);
});
app.MapGet("/api/settings/download", async (BoardStore board, CancellationToken cancellationToken) =>
{
    var file = CreateTemporaryFile();
    try
    {
        await BoardArchive.WriteAsync(file, board, cancellationToken);
        file.Position = 0;
        return Results.File(file, "application/zip", "ILINTEA-settings.zip");
    }
    catch
    {
        await file.DisposeAsync();
        throw;
    }
});
app.MapPost("/api/settings/upload", async (HttpContext context, BoardStore board) =>
{
    if (context.Request.ContentLength is 0 or > BoardArchive.MaxArchiveBytes)
        return Results.BadRequest(I18n.Error("errors.settingsFileSize"));
    if (context.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } bodyLimit)
        bodyLimit.MaxRequestBodySize = BoardArchive.MaxArchiveBytes;
    await using var file = CreateTemporaryFile();
    try
    {
        await context.Request.Body.CopyToAsync(file, context.RequestAborted);
        file.Position = 0;
        return Results.Ok(await BoardArchive.RestoreAsync(file, board, context.RequestAborted));
    }
    catch (BoardArchiveException exception)
    {
        return Results.BadRequest(I18n.Error(exception.ErrorKey));
    }
});
app.MapPatch("/api/canvas", (CanvasPatch patch, BoardStore board) =>
    patch.IsValid() ? Results.Ok(board.UpdateCanvas(patch))
        : Results.BadRequest(I18n.Error("errors.canvas")));
app.MapGet("/api/viewer-url", (HttpRequest request) =>
{
    var url = ViewerLink.Create(request);
    return url is null
        ? Results.Json(I18n.Error("errors.lanAddress"), statusCode: 503)
        : Results.Ok(new { url });
});
app.MapGet("/api/events", async (HttpContext context, BoardStore board) =>
{
    context.Response.ContentType = "text/event-stream";
    context.Response.Headers.CacheControl = "no-cache";
    var subscription = board.Subscribe();
    try
    {
        await foreach (var state in subscription.Reader.ReadAllAsync(context.RequestAborted))
        {
            await context.Response.WriteAsync($"data: {JsonSerializer.Serialize(state, json)}\n\n", context.RequestAborted);
            await context.Response.Body.FlushAsync(context.RequestAborted);
        }
    }
    catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested) { }
    finally { board.Unsubscribe(subscription.Id); }
});

app.MapPost("/api/elements", (CreateElement request, BoardStore board) =>
{
    if (request.Kind is not ("text" or "clock" or "script" or "alarm"))
        return Results.BadRequest(I18n.Error("errors.elementKind"));
    if (request.Kind == "script" && (string.IsNullOrWhiteSpace(request.Text) || !UploadLimits.TextFits(request.Text)))
        return Results.BadRequest(I18n.Error("errors.scriptContent"));
    if ((request.Text is not null && !UploadLimits.TextFits(request.Text)) ||
        (request.CountdownText is not null && !UploadLimits.TextFits(request.CountdownText)))
        return Results.BadRequest(I18n.Error("errors.settings"));
    var element = board.Add(request.Kind, text: request.Text, countdownText: request.CountdownText);
    return element is null ? Results.BadRequest(I18n.Error("errors.elementLimit")) : Results.Ok(element);
});

app.MapPost("/api/elements/{id:guid}/order", (Guid id, MoveElement request, BoardStore board) =>
{
    if (request.Offset is not (-1 or 1)) return Results.BadRequest(I18n.Error("errors.elementOrder"));
    var snapshot = board.Move(id, request.Offset);
    return snapshot is null ? Results.NotFound(I18n.Error("errors.elementMissing")) : Results.Ok(snapshot);
});

app.MapPost("/api/elements/{id:guid}/playback", (Guid id, ScriptControl control, BoardStore board) =>
{
    if (!control.IsValid()) return Results.BadRequest(I18n.Error("errors.scriptSpeed"));
    var element = board.ControlScript(id, control);
    return element is null ? Results.NotFound(I18n.Error("errors.scriptMissing")) : Results.Ok(element);
});

app.MapPatch("/api/elements/{id:guid}", (Guid id, ElementPatch patch, BoardStore board) =>
{
    if (!patch.IsValid()) return Results.BadRequest(I18n.Error("errors.settings"));
    var element = board.Update(id, patch);
    return element is null ? Results.NotFound(I18n.Error("errors.elementMissing")) : Results.Ok(element);
});

app.MapPut("/api/elements/{id:guid}/alarm", (Guid id, ScheduleAlarm request, BoardStore board, TimeProvider timeProvider) =>
{
    if (request.At <= timeProvider.GetUtcNow())
        return Results.BadRequest(I18n.Error("errors.alarmFuture"));
    var element = board.ScheduleAlarm(id, request);
    return element is null ? Results.NotFound(I18n.Error("errors.alarmMissing")) : Results.Ok(element);
});

app.MapDelete("/api/elements/{id:guid}/alarm/{scheduleId:guid}", (Guid id, Guid scheduleId, BoardStore board) =>
    board.CancelAlarm(id, scheduleId) ? Results.NoContent()
        : Results.NotFound(I18n.Error("errors.alarmScheduleMissing")));

app.MapPost("/api/elements/{id:guid}/display-schedule", (Guid id, ScheduleDisplay request, BoardStore board, TimeProvider timeProvider) =>
{
    if (request.DelaySeconds is < 1 or > 86400)
        return Results.BadRequest(I18n.Error("errors.displayDelay"));
    var current = board.Snapshot().Elements.FirstOrDefault(element => element.Id == id);
    if (current is null) return Results.NotFound(I18n.Error("errors.elementMissing"));
    if (current.Kind == "alarm" && (request.AlarmAt is null || request.AlarmAt <= timeProvider.GetUtcNow()))
        return Results.BadRequest(I18n.Error("errors.alarmFuture"));
    var element = board.ScheduleDisplay(id, request.DelaySeconds, request.AlarmAt);
    return element is null ? Results.NotFound(I18n.Error("errors.elementMissing")) : Results.Ok(element);
});
app.MapDelete("/api/elements/{id:guid}/display-schedule/{scheduleId:guid}", (Guid id, Guid scheduleId, BoardStore board) =>
    board.CancelDisplay(id, scheduleId) ? Results.NoContent()
        : Results.NotFound(I18n.Error("errors.scheduleMissing")));

app.MapDelete("/api/elements/{id:guid}", (Guid id, BoardStore board) =>
    board.Remove(id) ? Results.NoContent() : Results.NotFound(I18n.Error("errors.elementMissing")));

app.MapPost("/api/images", (IFormFile file, BoardStore board, CancellationToken cancellationToken) =>
    SaveImage(null, file, board, cancellationToken)).DisableAntiforgery();
app.MapPut("/api/images/{id:guid}", (Guid id, IFormFile file, BoardStore board, CancellationToken cancellationToken) =>
    SaveImage(id, file, board, cancellationToken)).DisableAntiforgery();

app.MapGet("/api/images/{id:guid}", (Guid id, BoardStore board) =>
{
    var image = board.GetImage(id);
    return image is null ? Results.NotFound() : Results.File(image.Bytes, image.ContentType);
});
app.MapGet("/view/", (IWebHostEnvironment environment) =>
    Results.File(Path.Combine(environment.WebRootPath, "index.html"), "text/html; charset=utf-8"));
app.Lifetime.ApplicationStarted.Register(() =>
{
    starting = false;
    Console.WriteLine("ILINTEA");
    Console.WriteLine($"  Local:   http://localhost:{port}/");
    if (ViewerLink.FindLanAddress() is { } address)
        Console.WriteLine($"  Network: http://{address}:{port}/");
    Console.WriteLine();
    Console.WriteLine("Press Ctrl+C to stop.");
});

try
{
    await app.RunAsync();
}
catch (Exception exception) when (starting && GetPortError(exception) is { } error)
{
    Console.Error.WriteLine($"Error: Cannot listen on port {port}: {error}");
    Console.Error.WriteLine("Stop the other app or change [Server] Port in ILINTEA.ini.");
    Environment.ExitCode = 1;
    if (!Console.IsInputRedirected)
    {
        Console.WriteLine("Press Enter to exit.");
        Console.ReadLine();
    }
}

static FileStream CreateTemporaryFile() => new(
    Path.Combine(Path.GetTempPath(), $"ILINTEA-{Guid.NewGuid():N}.tmp"),
    FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 81920,
    FileOptions.Asynchronous | FileOptions.DeleteOnClose);

static async Task<IResult> SaveImage(Guid? id, IFormFile file, BoardStore board, CancellationToken cancellationToken)
{
    if (file.Length is <= 0 or > UploadLimits.MaxFileBytes)
        return Results.BadRequest(I18n.Error("errors.imageSize"));
    var bytes = new byte[checked((int)file.Length)];
    using var stream = file.OpenReadStream();
    await stream.ReadExactlyAsync(bytes, cancellationToken);
    var contentType = ImageData.DetectContentType(bytes);
    if (contentType is null)
        return Results.BadRequest(I18n.Error("errors.imageFormat"));
    var image = new ImageData(bytes, contentType);
    var element = id is { } imageId ? board.ReplaceImage(imageId, image) : board.Add("image", image);
    if (element is not null) return Results.Ok(element);
    return id is not null ? Results.NotFound(I18n.Error("errors.elementMissing"))
        : Results.BadRequest(I18n.Error("errors.elementLimit"));
}

static string? GetPortError(Exception exception)
{
    for (Exception? cause = exception; cause is not null; cause = cause.InnerException)
    {
        if (cause is AddressInUseException or SocketException { SocketErrorCode: SocketError.AddressAlreadyInUse })
            return "address already in use.";
        if (cause is SocketException { SocketErrorCode: SocketError.AccessDenied })
            return "permission denied.";
    }
    return null;
}
