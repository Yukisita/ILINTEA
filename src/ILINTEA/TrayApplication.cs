#if WINDOWS
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;

namespace ILINTEA;

internal static class TrayApplication
{
    public static async Task RunAsync(WebApplication app, int port)
    {
        await using (app)
        {
            await app.StartAsync();
            var shutdown = app.WaitForShutdownAsync();
            try
            {
                await RunMessageLoopAsync(app.Lifetime, $"http://127.0.0.1:{port}/");
            }
            finally
            {
                app.Lifetime.StopApplication();
                await shutdown;
            }
        }
    }

    private static Task RunMessageLoopAsync(IHostApplicationLifetime lifetime, string editorUrl)
    {
        var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            try
            {
                RunMessageLoop(lifetime, editorUrl);
                completed.SetResult();
            }
            catch (Exception exception)
            {
                completed.SetException(exception);
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        return completed.Task;
    }

    private static void RunMessageLoop(IHostApplicationLifetime lifetime, string editorUrl)
    {
        ApplicationConfiguration.Initialize();
        using var context = new ApplicationContext();
        using var menu = new ContextMenuStrip();
        var open = menu.Items.Add(I18n.Text("tray.openEditor"));
        var exit = menu.Items.Add(I18n.Text("tray.exit"));
        open.Click += (_, _) => OpenEditor(editorUrl);
        exit.Click += (_, _) =>
        {
            open.Enabled = false;
            exit.Enabled = false;
            lifetime.StopApplication();
        };
        using var icon = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = I18n.Text("app.name"),
            ContextMenuStrip = menu
        };

        // Shutdown callbacks can run off the UI thread.
        using var dispatcher = new Control();
        _ = dispatcher.Handle;
        using var stopped = lifetime.ApplicationStopped.Register(() =>
            dispatcher.BeginInvoke((Action)context.ExitThread));
        icon.Visible = true;
        Application.Run(context);
    }

    private static void OpenEditor(string editorUrl)
    {
        try
        {
            using var browser = Process.Start(new ProcessStartInfo(editorUrl) { UseShellExecute = true });
        }
        catch (Win32Exception)
        {
            MessageBox.Show($"{I18n.Text("tray.browserError")}\n\n{editorUrl}", I18n.Text("app.name"),
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
#endif
