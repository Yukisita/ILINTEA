using System.Net.Sockets;
using System.Text.Json;
using Microsoft.AspNetCore.Connections;
using Microsoft.AspNetCore.Http.Features;
using StreamPrompter;

var starting = true;
var builder = WebApplication.CreateBuilder(args);
builder.Configuration.AddIniFile("StreamPrompter.ini", optional: false, reloadOnChange: false);
if (!int.TryParse(builder.Configuration["Server:Port"], out var port) || port is < 1 or > 65535)
    throw new InvalidOperationException("StreamPrompter.ini の [Server] Port は1～65535の整数で指定してください。");
builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
builder.Logging.ClearProviders();
builder.Logging.AddConsole();
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
builder.Logging.AddFilter("Microsoft.Hosting.Lifetime", LogLevel.Warning);
// Report expected port conflicts below; retain normal host diagnostics once running.
builder.Logging.AddFilter("Microsoft.Extensions.Hosting.Internal.Host", level => !starting || level >= LogLevel.Critical);
builder.Services.AddSingleton<BoardStore>();
builder.Services.Configure<FormOptions>(options => options.MultipartBodyLengthLimit = 3 * 1024 * 1024);
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 3 * 1024 * 1024);
var app = builder.Build();
var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/board", (BoardStore board) => board.Snapshot());
app.MapPatch("/api/canvas", (CanvasPatch patch, BoardStore board) =>
    patch.IsValid() ? Results.Ok(board.UpdateCanvas(patch))
        : Results.BadRequest(new { error = "画面比率は選択肢から、背景色は#に続く6桁の色コードで指定してください。" }));
app.MapGet("/api/viewer-url", (HttpRequest request) =>
{
    var url = ViewerLink.Create(request);
    return url is null
        ? Results.Json(new { error = "共有できるIPアドレスが見つかりません。Wi-Fiまたは有線LANの接続を確認してください。" }, statusCode: 503)
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
        return Results.BadRequest(new { error = "追加する要素の種類を確認してください。" });
    if (request.Kind == "script" && (string.IsNullOrWhiteSpace(request.Text) || request.Text.Length > 50000))
        return Results.BadRequest(new { error = "TXT原稿は1～50,000文字で指定してください。" });
    var element = board.Add(request.Kind, text: request.Text);
    return element is null ? Results.BadRequest(new { error = "要素は20個まで追加できます。" }) : Results.Ok(element);
});

app.MapPost("/api/elements/{id:guid}/playback", (Guid id, ScriptControl control, BoardStore board) =>
{
    if (!control.IsValid()) return Results.BadRequest(new { error = "スクロール速度は5～200の範囲で指定してください。" });
    var element = board.ControlScript(id, control);
    return element is null ? Results.NotFound(new { error = "TXT原稿が見つかりません。" }) : Results.Ok(element);
});

app.MapPatch("/api/elements/{id:guid}", (Guid id, ElementPatch patch, BoardStore board) =>
{
    if (!patch.IsValid()) return Results.BadRequest(new { error = "設定値を確認してください。" });
    var element = board.Update(id, patch);
    return element is null ? Results.NotFound(new { error = "この要素は削除されています。" }) : Results.Ok(element);
});

app.MapPut("/api/elements/{id:guid}/alarm", (Guid id, ScheduleAlarm request, BoardStore board) =>
{
    if (request.At <= DateTimeOffset.UtcNow)
        return Results.BadRequest(new { error = "通知日時は未来の日時を指定してください。" });
    var element = board.ScheduleAlarm(id, request);
    return element is null ? Results.NotFound(new { error = "このアラームは削除されています。" }) : Results.Ok(element);
});

app.MapPost("/api/elements/{id:guid}/display-schedule", (Guid id, ScheduleDisplay request, BoardStore board) =>
{
    if (request.DelaySeconds is < 1 or > 86400)
        return Results.BadRequest(new { error = "表示までの時間は1秒～24時間で指定してください。" });
    var element = board.ScheduleDisplay(id, request.DelaySeconds);
    return element is null ? Results.NotFound(new { error = "この要素は削除されています。" }) : Results.Ok(element);
});
app.MapDelete("/api/elements/{id:guid}/display-schedule/{scheduleId:guid}", (Guid id, Guid scheduleId, BoardStore board) =>
    board.CancelDisplay(id, scheduleId) ? Results.NoContent()
        : Results.NotFound(new { error = "表示予約は変更・解除済みか、表示時刻を過ぎています。" }));

app.MapDelete("/api/elements/{id:guid}", (Guid id, BoardStore board) =>
    board.Remove(id) ? Results.NoContent() : Results.NotFound(new { error = "この要素は削除されています。" }));

app.MapPost("/api/images", async (IFormFile file, BoardStore board, CancellationToken cancellationToken) =>
{
    if (file.Length is <= 0 or > 2 * 1024 * 1024)
        return Results.BadRequest(new { error = "画像は2MB以下にしてください。" });
    using var stream = new MemoryStream();
    await file.CopyToAsync(stream, cancellationToken);
    var bytes = stream.ToArray();
    var contentType = ImageData.DetectContentType(bytes);
    if (contentType is null)
        return Results.BadRequest(new { error = "PNG・JPEG・GIF・WebPの画像を選んでください。" });
    var element = board.Add("image", new ImageData(bytes, contentType));
    return element is null ? Results.BadRequest(new { error = "要素は20個まで追加できます。" }) : Results.Ok(element);
}).DisableAntiforgery();

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
    Console.WriteLine($"編集画面（このPC）: http://localhost:{port}/");
    Console.WriteLine($"閲覧画面（このPC）: http://localhost:{port}/view/");
    if (ViewerLink.FindLanAddress() is { } address)
    {
        Console.WriteLine($"編集画面（同じLANの端末）: http://{address}:{port}/");
        Console.WriteLine($"閲覧画面（同じLANの端末）: http://{address}:{port}/view/");
    }
    Console.WriteLine("終了するには Ctrl+C を押してください。");
});

try
{
    await app.RunAsync();
}
catch (Exception exception) when (starting && GetPortError(exception) is { } error)
{
    Console.Error.WriteLine($"ポート {port} で起動できませんでした。{error}");
    Console.Error.WriteLine("使用中のアプリを終了するか、StreamPrompter.ini の [Server] Port を変更して再起動してください。");
    Environment.ExitCode = 1;
    if (!Console.IsInputRedirected)
    {
        Console.WriteLine("終了するには Enter キーを押してください。");
        Console.ReadLine();
    }
}

static string? GetPortError(Exception exception)
{
    for (Exception? cause = exception; cause is not null; cause = cause.InnerException)
    {
        if (cause is AddressInUseException or SocketException { SocketErrorCode: SocketError.AddressAlreadyInUse })
            return "別のアプリが使用中です。";
        if (cause is SocketException { SocketErrorCode: SocketError.AccessDenied })
            return "使用が拒否されました。別のアプリによる占有や、OSのポート予約・アクセス制限を確認してください。";
    }
    return null;
}
