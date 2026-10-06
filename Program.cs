using System.Text.Json;
using Microsoft.AspNetCore.Http.Features;
using StreamPrompter;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
builder.Logging.AddConsole();
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
builder.Services.AddSingleton<BoardStore>();
builder.Services.Configure<FormOptions>(options => options.MultipartBodyLengthLimit = 3 * 1024 * 1024);
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 3 * 1024 * 1024);
var app = builder.Build();
var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/board", (BoardStore board) => board.Snapshot());
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
app.Run();
