using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace DelegatorAg;

internal static class Program
{
    private static Mutex? _singleInstanceMutex;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern uint RegisterWindowMessage(string lpString);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    private static readonly IntPtr HWND_BROADCAST = new(0xffff);
    internal static uint ShowWindowMsg;

    [STAThread]
    static void Main(string[] args)
    {
        string installRoot = AppContext.BaseDirectory.TrimEnd('\\', '/');
        if (!File.Exists(Path.Combine(installRoot, "delegator-core.exe")))
        {
            string standardInstall = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs", "Delegator");
            if (File.Exists(Path.Combine(standardInstall, "delegator-core.exe")))
            {
                installRoot = standardInstall;
            }
        }

        foreach (var arg in args)
        {
            if (string.Equals(arg, "--remove-hooks", StringComparison.OrdinalIgnoreCase))
            {
                IdeHelper.RemoveAllHooks(installRoot);
                return;
            }
            if (string.Equals(arg, "--disable-autostart", StringComparison.OrdinalIgnoreCase))
            {
                SetAutostart(false);
                return;
            }
        }

        ShowWindowMsg = RegisterWindowMessage("Delegator.SingleInstance.ShowWindow.v1");
        _singleInstanceMutex = new Mutex(true, @"Local\Delegator.SingleInstance.v1", out bool isNew);
        if (!isNew)
        {
            PostMessage(HWND_BROADCAST, ShowWindowMsg, IntPtr.Zero, IntPtr.Zero);
            return;
        }

        bool startMinimized = false;
        foreach (var arg in args)
        {
            if (string.Equals(arg, "--background", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(arg, "--minimized", StringComparison.OrdinalIgnoreCase))
            {
                startMinimized = true;
            }
        }

        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            Application.Run(new MainForm(installRoot, startMinimized));
        }
        catch (Exception ex)
        {
            string logPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DelegatorWin", "error.log");
            File.WriteAllText(logPath, ex.ToString());
            MessageBox.Show(ex.ToString(), "Delegator Error");
        }
    }

    internal static bool GetAutostart()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", false);
            return key?.GetValue("Delegator") != null;
        }
        catch { return false; }
    }

    internal static void SetAutostart(bool enable)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true);
            if (key == null) return;
            if (enable)
            {
                string exe = Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "delegator.exe");
                key.SetValue("Delegator", $"\"{exe}\" --background");
            }
            else
            {
                key.DeleteValue("Delegator", false);
            }
        }
        catch { }
    }
}

internal sealed class MainForm : Form
{
    private readonly string _installRoot;
    private readonly bool _startMinimized;
    private readonly WebView2 _webView;
    private readonly NotifyIcon _trayIcon;
    private readonly ToolStripMenuItem _toggleMenuItem;
    private readonly ToolStripMenuItem _autostartMenuItem;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(6) };
    private readonly System.Windows.Forms.Timer _supervisorTimer;
    private Process? _coreProcess;
    private bool _allowExit;
    private bool _webReady;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    [DllImport("user32.dll")]
    private static extern IntPtr SetCapture(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int Msg, int wParam, int lParam);

    public MainForm(string installRoot, bool startMinimized)
    {
        _installRoot = installRoot;
        _startMinimized = startMinimized;

        Text = "Delegator";
        FormBorderStyle = FormBorderStyle.None;
        Size = new Size(1020, 620);
        MinimumSize = new Size(780, 480);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(7, 7, 9);
        ForeColor = Color.FromArgb(255, 255, 255);

        Icon? appIcon = LoadEmbeddedIcon();
        if (appIcon != null) Icon = appIcon;

        var menu = new ContextMenuStrip();
        var openItem = new ToolStripMenuItem("Открыть", null, (_, _) => ShowMainWindow());
        _toggleMenuItem = new ToolStripMenuItem("Отключить делегирование", null, (_, _) => ToggleDelegationFromTray());
        _autostartMenuItem = new ToolStripMenuItem("Запускать с Windows") { Checked = Program.GetAutostart() };
        _autostartMenuItem.Click += (_, _) =>
        {
            bool next = !Program.GetAutostart();
            Program.SetAutostart(next);
            _autostartMenuItem.Checked = next;
        };
        var quitItem = new ToolStripMenuItem("Выйти", null, (_, _) => QuitApp());

        menu.Items.Add(openItem);
        menu.Items.Add(_toggleMenuItem);
        menu.Items.Add(_autostartMenuItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(quitItem);

        _trayIcon = new NotifyIcon
        {
            Icon = appIcon ?? SystemIcons.Application,
            Text = "Delegator v0.9.40",
            ContextMenuStrip = menu,
            Visible = true
        };
        _trayIcon.DoubleClick += (_, _) => ShowMainWindow();

        _webView = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = Color.FromArgb(7, 7, 9)
        };
        Controls.Add(_webView);

        _supervisorTimer = new System.Windows.Forms.Timer { Interval = 3000 };
        _supervisorTimer.Tick += async (_, _) => await SupervisorTickAsync();

        Shown += async (_, _) => await OnFormShownAsync();
        FormClosing += OnFormClosing;
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int dark = 1;
        DwmSetWindowAttribute(Handle, 20, ref dark, sizeof(int));
        int cornerPref = 2; // DWMWCP_ROUND
        DwmSetWindowAttribute(Handle, 33, ref cornerPref, sizeof(int));
        int borderColor = 0x001E1B1B; // subtle dark border
        DwmSetWindowAttribute(Handle, 34, ref borderColor, sizeof(int));
        int captionColor = 0x00090707; // BGR for #070709
        DwmSetWindowAttribute(Handle, 35, ref captionColor, sizeof(int));
    }

    protected override void WndProc(ref Message m)
    {
        if (Program.ShowWindowMsg != 0 && m.Msg == Program.ShowWindowMsg)
        {
            ShowMainWindow();
            return;
        }
        base.WndProc(ref m);
    }

    private static Icon? LoadEmbeddedIcon()
    {
        try
        {
            var asm = Assembly.GetExecutingAssembly();
            foreach (var name in asm.GetManifestResourceNames())
            {
                if (name.EndsWith("delegator.ico", StringComparison.OrdinalIgnoreCase))
                {
                    using var stream = asm.GetManifestResourceStream(name);
                    if (stream != null) return new Icon(stream);
                }
            }
        }
        catch { }
        return null;
    }

    private static string LoadEmbeddedHtml()
    {
        var asm = Assembly.GetExecutingAssembly();
        foreach (var name in asm.GetManifestResourceNames())
        {
            if (name.EndsWith("ui.html", StringComparison.OrdinalIgnoreCase))
            {
                using var stream = asm.GetManifestResourceStream(name);
                if (stream != null)
                {
                    using var sr = new StreamReader(stream, Encoding.UTF8);
                    return sr.ReadToEnd();
                }
            }
        }
        return "<html><body style='background:#0a0a0a;color:#fff'>UI missing</body></html>";
    }

    private async Task OnFormShownAsync()
    {
        try
        {
            string dbg = $"Form.Handle={Handle}, Form.IsHandleCreated={IsHandleCreated}, WebView.Handle={_webView.Handle}, WebView.IsHandleCreated={_webView.IsHandleCreated}";
            string logPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DelegatorWin", "debug.log");
            File.WriteAllText(logPath, dbg + "\n");

            UpdateTrayLabels();
            _ = Task.Run(EnsureCoreAndBridgeRunningAsync);
            _supervisorTimer.Start();

            string userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DelegatorWin", "webview2");
            Directory.CreateDirectory(userDataFolder);

            var env = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
            await _webView.EnsureCoreWebView2Async(env);
            _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            _webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
            _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            _webView.CoreWebView2.Settings.IsNonClientRegionSupportEnabled = true;
            _webView.CoreWebView2.WebMessageReceived += async (_, args) => await HandleWebMessageAsync(args.TryGetWebMessageAsString());
            _webView.NavigateToString(LoadEmbeddedHtml());
            _webReady = true;

            if (_startMinimized)
            {
                WindowState = FormWindowState.Minimized;
                ShowInTaskbar = false;
                Hide();
            }
        }
        catch (Exception ex)
        {
            string logPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DelegatorWin", "error.log");
            File.AppendAllText(logPath, "OnFormShownAsync failed: " + ex + "\n");
        }
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (!_allowExit && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            ShowInTaskbar = false;
        }
    }

    private void ShowMainWindow()
    {
        ShowInTaskbar = true;
        Show();
        if (WindowState == FormWindowState.Minimized)
            WindowState = FormWindowState.Normal;
        Activate();
    }

    private void QuitApp()
    {
        _allowExit = true;
        _supervisorTimer.Stop();
        _trayIcon.Visible = false;
        try
        {
            if (_coreProcess != null && !_coreProcess.HasExited)
                _coreProcess.Kill(true);
        }
        catch { }
        Application.Exit();
    }

    private void ToggleDelegationFromTray()
    {
        var cfg = ConfigStore.Load();
        bool next = !(cfg["delegator_enabled"]?.GetValue<bool>() ?? true);
        cfg["delegator_enabled"] = next;
        ConfigStore.Save(cfg);
        UpdateTrayLabels();
        if (_webReady)
            _ = SendStateToWebAsync();
    }

    private void UpdateTrayLabels()
    {
        var cfg = ConfigStore.Load();
        bool enabled = cfg["delegator_enabled"]?.GetValue<bool>() ?? true;
        _toggleMenuItem.Text = enabled ? "Отключить делегирование" : "Включить делегирование";
        _trayIcon.Text = enabled ? "Delegator v0.9.40 — Активен" : "Delegator v0.9.40 — Пауза";
    }

    private async Task EnsureCoreAndBridgeRunningAsync()
    {
        try
        {
            if (await IsCoreHealthyAsync()) return;
            string coreExe = Path.Combine(_installRoot, "delegator-core.exe");
            string runtimeDir = Path.Combine(_installRoot, "runtime");
            string delegateCmd = Path.Combine(runtimeDir, "ai-delegate.cmd");
            if (!File.Exists(coreExe)) return;

            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string dataRoot = Path.Combine(localAppData, "DelegatorWin");
            string runtimeHome = Path.Combine(dataRoot, "runtime");
            string coreHome = Path.Combine(dataRoot, "core");
            Directory.CreateDirectory(runtimeHome);
            Directory.CreateDirectory(coreHome);

            var psi = new ProcessStartInfo
            {
                FileName = coreExe,
                WorkingDirectory = _installRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            psi.Environment["DELEGATOR_RUNTIME_DIR"] = runtimeDir;
            psi.Environment["DELEGATOR_RUNTIME_HOME"] = runtimeHome;
            psi.Environment["DELEGATOR_CORE_HOME"] = coreHome;
            psi.Environment["DELEGATOR_CORE_DELEGATE_CMD"] = delegateCmd;
            psi.Environment["DELEGATOR_SUPERVISED"] = "1";
            psi.Environment["PYTHONUNBUFFERED"] = "1";
            _coreProcess = Process.Start(psi);
            if (_coreProcess != null)
            {
                _coreProcess.OutputDataReceived += (_, _) => { };
                _coreProcess.ErrorDataReceived += (_, _) => { };
                _coreProcess.BeginOutputReadLine();
                _coreProcess.BeginErrorReadLine();
            }

            string ensureBridge = Path.Combine(runtimeDir, "ensure-web-bridge.ps1");
            if (File.Exists(ensureBridge))
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = $"-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"{ensureBridge}\"",
                    UseShellExecute = false,
                    CreateNoWindow = true
                });
            }
        }
        catch { }
    }

    private async Task<bool> IsCoreHealthyAsync()
    {
        try
        {
            using var cts = new CancellationTokenSource(800);
            var res = await _http.GetStringAsync("http://127.0.0.1:1380/health", cts.Token);
            return res.Contains("\"ok\":true") || res.Contains("\"ok\": true");
        }
        catch { return false; }
    }

    private async Task SupervisorTickAsync()
    {
        try
        {
            if (!await IsCoreHealthyAsync())
                _ = Task.Run(EnsureCoreAndBridgeRunningAsync);
        }
        catch { }
    }

    private async Task HandleWebMessageAsync(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return;
        try
        {
            var msg = JsonNode.Parse(raw) as JsonObject;
            string action = msg?["action"]?.GetValue<string>() ?? "";
            var cfg = ConfigStore.Load();

            switch (action)
            {
                case "win_drag":
                    BeginInvoke(new Action(() =>
                    {
                        SetCapture(Handle);
                        ReleaseCapture();
                        SendMessage(Handle, 0xA1, 0x2, 0);
                    }));
                    break;

                case "win_minimize":
                    BeginInvoke(new Action(() => WindowState = FormWindowState.Minimized));
                    break;

                case "win_maximize":
                    BeginInvoke(new Action(() =>
                    {
                        WindowState = WindowState == FormWindowState.Maximized
                            ? FormWindowState.Normal
                            : FormWindowState.Maximized;
                    }));
                    break;

                case "win_close":
                    BeginInvoke(new Action(() => Close()));
                    break;

                case "init":
                case "poll":
                    await SendStateToWebAsync();
                    break;

                case "toggle_delegator":
                {
                    bool enabled = msg?["enabled"]?.GetValue<bool>() ?? !(cfg["delegator_enabled"]?.GetValue<bool>() ?? true);
                    cfg["delegator_enabled"] = enabled;
                    ConfigStore.Save(cfg);
                    UpdateTrayLabels();
                    await SendStateToWebAsync();
                    break;
                }

                case "toggle_ide":
                {
                    string ide = msg?["id"]?.GetValue<string>() ?? "";
                    bool enabled = msg?["enabled"]?.GetValue<bool>() ?? false;
                    if (!string.IsNullOrEmpty(ide))
                    {
                        var states = cfg["ide_states"] as JsonObject ?? new JsonObject();
                        states[ide] = enabled;
                        cfg["ide_states"] = states;
                        ConfigStore.Save(cfg);
                        bool delEnabled = cfg["delegator_enabled"]?.GetValue<bool>() ?? true;
                        IdeHelper.ApplyHook(ide, enabled && delEnabled, _installRoot);
                    }
                    await SendStateToWebAsync();
                    break;
                }

                case "toggle_web_door":
                {
                    string id = msg?["id"]?.GetValue<string>() ?? "";
                    bool enabled = msg?["enabled"]?.GetValue<bool>() ?? false;
                    string? prop = id switch
                    {
                        "gemini" => "gemini_web_enabled",
                        "aistudio" => "aistudio_web_enabled",
                        "zai" => "zai_web_enabled",
                        "qwen" => "qwen_web_enabled",
                        "deepseek" => "deepseek_web_enabled",
                        _ => null
                    };
                    if (prop != null)
                    {
                        cfg[prop] = enabled;
                        ConfigStore.Save(cfg);
                    }
                    await SendStateToWebAsync();
                    break;
                }

                case "set_gemini_web_opts":
                {
                    string? model = msg?["model"]?.GetValue<string>();
                    string? reasoning = msg?["reasoning"]?.GetValue<string>();
                    if (!string.IsNullOrEmpty(model)) cfg["gemini_web_model"] = model;
                    if (!string.IsNullOrEmpty(reasoning)) cfg["gemini_web_reasoning"] = reasoning;
                    ConfigStore.Save(cfg);
                    await SendStateToWebAsync();
                    break;
                }

                case "web_login":
                {
                    string door = msg?["id"]?.GetValue<string>() ?? "";
                    string? prop = door switch
                    {
                        "gemini" => "gemini_web_enabled",
                        "aistudio" => "aistudio_web_enabled",
                        "zai" => "zai_web_enabled",
                        "qwen" => "qwen_web_enabled",
                        "deepseek" => "deepseek_web_enabled",
                        _ => null
                    };
                    if (prop != null)
                    {
                        cfg[prop] = true;
                        ConfigStore.Save(cfg);
                    }
                    try
                    {
                        var body = new StringContent(JsonSerializer.Serialize(new { door }), Encoding.UTF8, "application/json");
                        await _http.PostAsync("http://127.0.0.1:1380/api/web/login", body);
                    }
                    catch { }
                    await SendStateToWebAsync();
                    break;
                }

                case "add_google_key":
                {
                    string label = msg?["label"]?.GetValue<string>()?.Trim() ?? "";
                    string key = msg?["key"]?.GetValue<string>()?.Trim() ?? "";
                    if (!string.IsNullOrEmpty(key))
                    {
                        var arr = cfg["google_accounts"] as JsonArray ?? new JsonArray();
                        if (string.IsNullOrEmpty(label)) label = $"Google {arr.Count + 1}";
                        arr.Add(new JsonObject
                        {
                            ["id"] = "google-" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                            ["label"] = label,
                            ["api_key_enc"] = NativeDpapi.EncryptString(key),
                            ["enabled"] = true
                        });
                        cfg["google_accounts"] = arr;
                        ConfigStore.Save(cfg);
                    }
                    await SendStateToWebAsync();
                    break;
                }

                case "delete_google_key":
                {
                    string id = msg?["id"]?.GetValue<string>() ?? "";
                    var arr = cfg["google_accounts"] as JsonArray;
                    if (arr != null)
                    {
                        for (int i = arr.Count - 1; i >= 0; i--)
                        {
                            if (arr[i]?["id"]?.GetValue<string>() == id)
                                arr.RemoveAt(i);
                        }
                        ConfigStore.Save(cfg);
                    }
                    await SendStateToWebAsync();
                    break;
                }

                case "toggle_google_key":
                {
                    string id = msg?["id"]?.GetValue<string>() ?? "";
                    bool enabled = msg?["enabled"]?.GetValue<bool>() ?? true;
                    var arr = cfg["google_accounts"] as JsonArray;
                    if (arr != null)
                    {
                        foreach (var item in arr)
                        {
                            if (item?["id"]?.GetValue<string>() == id)
                                item["enabled"] = enabled;
                        }
                        ConfigStore.Save(cfg);
                    }
                    await SendStateToWebAsync();
                    break;
                }

                case "toggle_gemini_model":
                {
                    string model = msg?["model"]?.GetValue<string>() ?? "";
                    bool enabled = msg?["enabled"]?.GetValue<bool>() ?? false;
                    var arr = cfg["enabled_gemini_models"] as JsonArray ?? new JsonArray();
                    bool exists = false;
                    for (int i = arr.Count - 1; i >= 0; i--)
                    {
                        if (arr[i]?.GetValue<string>() == model)
                        {
                            exists = true;
                            if (!enabled) arr.RemoveAt(i);
                        }
                    }
                    if (enabled && !exists && !string.IsNullOrEmpty(model))
                        arr.Add(model);
                    cfg["enabled_gemini_models"] = arr;
                    ConfigStore.Save(cfg);
                    await SendStateToWebAsync();
                    break;
                }
            }
        }
        catch { }
    }

    private async Task SendStateToWebAsync()
    {
        if (!_webReady || _webView.CoreWebView2 == null) return;
        try
        {
            var cfg = ConfigStore.Load();
            JsonNode? webDoors = null;
            JsonNode? usage = null;
            try
            {
                string doorsRaw = await _http.GetStringAsync("http://127.0.0.1:1380/api/web/doors");
                webDoors = JsonNode.Parse(doorsRaw);
            }
            catch { }
            try
            {
                string usageRaw = await _http.GetStringAsync("http://127.0.0.1:1380/api/usage?days=7");
                usage = JsonNode.Parse(usageRaw);
            }
            catch { }

            var googleSafe = new JsonArray();
            if (cfg["google_accounts"] is JsonArray gArr)
            {
                foreach (var g in gArr)
                {
                    if (g is JsonObject go)
                    {
                        string plain = NativeDpapi.DecryptString(go["api_key_enc"]?.GetValue<string>() ?? "");
                        string masked = plain.Length > 8 ? $"{plain[..4]}••••{plain[^4..]}" : "••••••••";
                        googleSafe.Add(new JsonObject
                        {
                            ["id"] = go["id"]?.GetValue<string>() ?? "",
                            ["label"] = go["label"]?.GetValue<string>() ?? "Google",
                            ["masked"] = masked,
                            ["enabled"] = go["enabled"]?.GetValue<bool>() ?? true
                        });
                    }
                }
            }

            var payload = new JsonObject
            {
                ["delegatorEnabled"] = cfg["delegator_enabled"]?.GetValue<bool>() ?? true,
                ["ides"] = IdeHelper.GetIdesState(cfg),
                ["webConfig"] = new JsonObject
                {
                    ["gemini"] = cfg["gemini_web_enabled"]?.GetValue<bool>() ?? false,
                    ["aistudio"] = cfg["aistudio_web_enabled"]?.GetValue<bool>() ?? true,
                    ["zai"] = cfg["zai_web_enabled"]?.GetValue<bool>() ?? true,
                    ["qwen"] = cfg["qwen_web_enabled"]?.GetValue<bool>() ?? true,
                    ["deepseek"] = cfg["deepseek_web_enabled"]?.GetValue<bool>() ?? true,
                    ["model"] = cfg["gemini_web_model"]?.GetValue<string>() ?? "best",
                    ["reasoning"] = cfg["gemini_web_reasoning"]?.GetValue<string>() ?? "best"
                },
                ["webDoors"] = webDoors ?? new JsonObject { ["connected"] = false, ["doors"] = new JsonArray() },
                ["googleAccounts"] = googleSafe,
                ["enabledGeminiModels"] = cfg["enabled_gemini_models"]?.DeepClone() ?? new JsonArray(),
                ["usage"] = ThinkingReader.BuildStats(usage),
                ["thinking"] = ThinkingReader.ReadTraces()
            };

            string json = payload.ToJsonString();
            if (InvokeRequired)
                BeginInvoke(new Action(() => _webView.CoreWebView2.PostWebMessageAsJson(json)));
            else
                _webView.CoreWebView2.PostWebMessageAsJson(json);
        }
        catch { }
    }
}
