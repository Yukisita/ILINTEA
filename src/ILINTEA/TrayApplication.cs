#if WINDOWS
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Net;
using System.Windows.Forms;

namespace ILINTEA;

internal static class TrayApplication
{
    public static Mutex? AcquireInstance()
    {
        // Keep the named handle alive until this Windows session's instance exits.
        var instance = new Mutex(false, @"Local\ILINTEA.SingleInstance.33F2B568-191D-4B74-8B53-F6EC877ABF53", out var created);
        if (created) return instance;

        instance.Dispose();
        MessageBox.Show(I18n.Text("tray.alreadyRunning"), I18n.Text("app.name"),
            MessageBoxButtons.OK, MessageBoxIcon.Information);
        return null;
    }

    public static void ShowStartupError(string message)
    {
        MessageBox.Show(message, I18n.Text("app.name"), MessageBoxButtons.OK, MessageBoxIcon.Error);
        Environment.ExitCode = 1;
    }

    public static async Task RunAsync(WebApplication app, int port)
    {
        await using (app)
        {
            await app.StartAsync();
            var shutdown = app.WaitForShutdownAsync();
            try
            {
                await RunMessageLoopAsync(app.Lifetime, port);
            }
            finally
            {
                app.Lifetime.StopApplication();
                await shutdown;
            }
        }
    }

    private static Task RunMessageLoopAsync(IHostApplicationLifetime lifetime, int port)
    {
        var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            try
            {
                RunMessageLoop(lifetime, port);
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

    private static void RunMessageLoop(IHostApplicationLifetime lifetime, int port)
    {
        ApplicationConfiguration.Initialize();
        using var context = new ApplicationContext();
        using var menu = new ContextMenuStrip();
        var open = menu.Items.Add(I18n.Text("tray.openEditor"));
        var exit = menu.Items.Add(I18n.Text("tray.exit"));
        open.Click += (_, _) => OpenEditor(port);
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

    private static void OpenEditor(int port)
    {
        var address = ViewerLink.FindLanAddress() ?? IPAddress.Loopback;
        var editorUrl = $"http://{address}:{port}/";
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
