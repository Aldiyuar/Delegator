using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Win32;

namespace DelegatorAg;

internal static class NativeDpapi
{
    [StructLayout(LayoutKind.Sequential)]
    private struct DATA_BLOB
    {
        public uint cbData;
        public IntPtr pbData;
    }

    [DllImport("crypt32.dll", SetLastError = true)]
    private static extern bool CryptProtectData(
        ref DATA_BLOB pDataIn,
        IntPtr szDataDescr,
        IntPtr pOptionalEntropy,
        IntPtr pvReserved,
        IntPtr pPromptStruct,
        uint dwFlags,
        out DATA_BLOB pDataOut);

    [DllImport("crypt32.dll", SetLastError = true)]
    private static extern bool CryptUnprotectData(
        ref DATA_BLOB pDataIn,
        IntPtr ppszDataDescr,
        IntPtr pOptionalEntropy,
        IntPtr pvReserved,
        IntPtr pPromptStruct,
        uint dwFlags,
        out DATA_BLOB pDataOut);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr hMem);

    private const uint CRYPTPROTECT_UI_FORBIDDEN = 0x1;

    public static string EncryptString(string plain)
    {
        if (string.IsNullOrEmpty(plain)) return "";
        byte[] bytes = Encoding.UTF8.GetBytes(plain);
        GCHandle handle = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try
        {
            var inBlob = new DATA_BLOB { cbData = (uint)bytes.Length, pbData = handle.AddrOfPinnedObject() };
            if (!CryptProtectData(ref inBlob, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, out var outBlob))
                throw new InvalidOperationException("DPAPI CryptProtectData failed");
            try
            {
                byte[] result = new byte[outBlob.cbData];
                Marshal.Copy(outBlob.pbData, result, 0, (int)outBlob.cbData);
                return Convert.ToBase64String(result);
            }
            finally
            {
                LocalFree(outBlob.pbData);
            }
        }
        finally
        {
            handle.Free();
        }
    }

    public static string DecryptString(string encBase64)
    {
        if (string.IsNullOrWhiteSpace(encBase64)) return "";
        byte[] bytes = Convert.FromBase64String(encBase64.Trim());
        GCHandle handle = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try
        {
            var inBlob = new DATA_BLOB { cbData = (uint)bytes.Length, pbData = handle.AddrOfPinnedObject() };
            if (!CryptUnprotectData(ref inBlob, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, out var outBlob))
                return "";
            try
            {
                byte[] result = new byte[outBlob.cbData];
                Marshal.Copy(outBlob.pbData, result, 0, (int)outBlob.cbData);
                return Encoding.UTF8.GetString(result);
            }
            finally
            {
                LocalFree(outBlob.pbData);
            }
        }
        catch
        {
            return "";
        }
        finally
        {
            handle.Free();
        }
    }
}

internal static class ConfigStore
{
    private static readonly object SyncLock = new();

    public static string ConfigPath
    {
        get
        {
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string dir = Path.Combine(appData, "Delegator", "DelegatorWin", "config");
            Directory.CreateDirectory(dir);
            return Path.Combine(dir, "config.json");
        }
    }

    public static string RuntimeHome
    {
        get
        {
            string? env = Environment.GetEnvironmentVariable("DELEGATOR_RUNTIME_HOME");
            if (!string.IsNullOrWhiteSpace(env)) return env;
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string dir = Path.Combine(localAppData, "DelegatorWin", "runtime");
            Directory.CreateDirectory(dir);
            return dir;
        }
    }

    public static JsonObject Load()
    {
        lock (SyncLock)
        {
            string path = ConfigPath;
            if (File.Exists(path))
            {
                try
                {
                    string raw = File.ReadAllText(path, Encoding.UTF8);
                    var node = JsonNode.Parse(raw) as JsonObject;
                    if (node != null)
                    {
                        EnsureDefaults(node);
                        return node;
                    }
                }
                catch { }
            }
            var fresh = new JsonObject();
            EnsureDefaults(fresh);
            Save(fresh);
            return fresh;
        }
    }

    public static void Save(JsonObject cfg)
    {
        lock (SyncLock)
        {
            EnsureDefaults(cfg);
            string path = ConfigPath;
            string tmp = path + ".tmp";
            var opts = new JsonSerializerOptions { WriteIndented = true };
            File.WriteAllText(tmp, cfg.ToJsonString(opts), new UTF8Encoding(false));
            File.Move(tmp, path, true);
        }
    }

    private static void EnsureDefaults(JsonObject cfg)
    {
        if (cfg["config_version"] == null) cfg["config_version"] = 13;
        if (cfg["google_accounts"] == null) cfg["google_accounts"] = new JsonArray();
        if (cfg["opencode_accounts"] == null) cfg["opencode_accounts"] = new JsonArray();
        if (cfg["enabled_gemini_models"] == null)
            cfg["enabled_gemini_models"] = new JsonArray("gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-pro-latest", "gemini-flash-latest", "gemini-flash-lite-latest");
        if (cfg["enabled_opencode_models"] == null)
            cfg["enabled_opencode_models"] = new JsonArray("openrouter/openrouter/free", "opencode/big-pickle", "opencode/beam-free", "opencode/deepseek-v4.1-flash-free", "opencode/glm-5.3-flash-free");
        if (cfg["known_opencode_models"] == null)
            cfg["known_opencode_models"] = new JsonArray("opencode/big-pickle", "opencode/beam-free", "opencode/deepseek-v4.1-flash-free", "opencode/glm-5.3-flash-free");
        if (cfg["custom_providers"] == null) cfg["custom_providers"] = new JsonArray();
        if (cfg["proxies"] == null) cfg["proxies"] = new JsonArray();
        if (cfg["ide_states"] == null)
        {
            cfg["ide_states"] = new JsonObject
            {
                ["Antigravity"] = false,
                ["Codex"] = false,
                ["OpenCode"] = false,
                ["Cursor"] = false,
                ["Claude"] = false,
                ["VS Code"] = false,
                ["VSCodium"] = false
            };
        }
        if (cfg["delegator_enabled"] == null) cfg["delegator_enabled"] = true;
        if (cfg["gemini_web_enabled"] == null) cfg["gemini_web_enabled"] = false;
        if (cfg["gemini_web_model"] == null) cfg["gemini_web_model"] = "best";
        if (cfg["gemini_web_reasoning"] == null) cfg["gemini_web_reasoning"] = "best";
        if (cfg["aistudio_web_enabled"] == null) cfg["aistudio_web_enabled"] = true;
        if (cfg["zai_web_enabled"] == null) cfg["zai_web_enabled"] = true;
        if (cfg["qwen_web_enabled"] == null) cfg["qwen_web_enabled"] = true;
        if (cfg["deepseek_web_enabled"] == null) cfg["deepseek_web_enabled"] = true;
        // Kimi, Tencent, Rudder forced off per user design
        cfg["kimi_web_enabled"] = false;
        cfg["tencent_web_enabled"] = false;
        cfg["rudder_web_enabled"] = false;
        if (cfg["gemini_alias_versions"] == null) cfg["gemini_alias_versions"] = new JsonObject();
    }
}

internal static class IdeHelper
{
    private const string HookHeader = "<!-- DELEGATOR_HOOK_START -->";
    private const string HookFooter = "<!-- DELEGATOR_HOOK_END -->";

    private static readonly (string Key, string Label)[] IdeList = new[]
    {
        ("Antigravity", "Antigravity"),
        ("Codex", "Codex (ChatGPT)"),
        ("OpenCode", "OpenCode"),
        ("Cursor", "Cursor"),
        ("Claude", "Claude"),
        ("VS Code", "VS Code"),
        ("VSCodium", "VSCodium")
    };

    public static JsonArray GetIdesState(JsonObject cfg)
    {
        var arr = new JsonArray();
        var states = cfg["ide_states"] as JsonObject ?? new JsonObject();
        bool delegatorEnabled = cfg["delegator_enabled"]?.GetValue<bool>() ?? true;
        foreach (var (key, label) in IdeList)
        {
            bool detected = IsDetected(key);
            bool enabled = states[key]?.GetValue<bool>() ?? false;
            bool hooked = IsHooked(key);
            arr.Add(new JsonObject
            {
                ["id"] = key,
                ["label"] = label,
                ["detected"] = detected,
                ["enabled"] = enabled,
                ["hooked"] = hooked && delegatorEnabled,
                ["hint"] = key == "Antigravity"
                    ? "Для Antigravity работает умное автоделегирование через delegator-routing.md"
                    : ""
            });
        }
        return arr;
    }

    public static bool IsDetected(string name)
    {
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return name switch
        {
            "Antigravity" => Directory.Exists(Path.Combine(home, ".gemini", "antigravity"))
                          || Directory.Exists(Path.Combine(localAppData, "Programs", "Antigravity")),
            "Codex" => Directory.Exists(Path.Combine(home, ".codex")),
            "OpenCode" => Directory.Exists(Path.Combine(home, ".config", "opencode"))
                       || Directory.Exists(Path.Combine(home, ".local", "share", "opencode")),
            "Cursor" => Directory.Exists(Path.Combine(appData, "Cursor"))
                     || Directory.Exists(Path.Combine(home, ".cursor")),
            "Claude" => Directory.Exists(Path.Combine(appData, "Claude"))
                     || Directory.Exists(Path.Combine(home, ".claude")),
            "VS Code" => Directory.Exists(Path.Combine(appData, "Code"))
                      || Directory.Exists(Path.Combine(home, ".vscode")),
            "VSCodium" => Directory.Exists(Path.Combine(appData, "VSCodium"))
                       || Directory.Exists(Path.Combine(home, ".vscode-oss")),
            _ => false
        };
    }

    private static string[] GetTargetFiles(string name)
    {
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        return name switch
        {
            "Antigravity" => new[]
            {
                Path.Combine(home, ".gemini", "GEMINI.md"),
                Path.Combine(home, ".gemini", "config", "AGENTS.md")
            },
            "Codex" => new[] { Path.Combine(home, ".codex", "AGENTS.md") },
            "OpenCode" => new[] { Path.Combine(home, ".config", "opencode", "AGENTS.md") },
            "Cursor" => new[] { Path.Combine(home, ".cursor", "rules", "delegator.mdc") },
            "Claude" => new[]
            {
                Path.Combine(home, ".claude", "CLAUDE.md"),
                Path.Combine(appData, "Claude", "CLAUDE.md")
            },
            "VS Code" => new[] { Path.Combine(home, ".copilot", "instructions", "delegator.instructions.md") },
            "VSCodium" => new[] { Path.Combine(appData, "VSCodium", "User", "prompts", "delegator.instructions.md") },
            _ => Array.Empty<string>()
        };
    }

    public static bool IsHooked(string name)
    {
        foreach (var path in GetTargetFiles(name))
        {
            if (File.Exists(path))
            {
                try
                {
                    if (File.ReadAllText(path).Contains(HookHeader)) return true;
                }
                catch { }
            }
        }
        return false;
    }

    public static void ApplyHook(string name, bool enable, string installRoot)
    {
        string entry = Path.Combine(installRoot, "runtime", "ai-delegate.cmd");
        foreach (var path in GetTargetFiles(name))
        {
            try
            {
                if (!enable)
                {
                    if (!File.Exists(path)) continue;
                    string content = File.ReadAllText(path, Encoding.UTF8);
                    int s = content.IndexOf(HookHeader, StringComparison.Ordinal);
                    int e = content.IndexOf(HookFooter, StringComparison.Ordinal);
                    if (s >= 0 && e > s)
                    {
                        string updated = (content[..s] + content[(e + HookFooter.Length)..]).Trim();
                        if (string.IsNullOrWhiteSpace(updated) && (path.EndsWith("delegator.mdc") || path.EndsWith("delegator.instructions.md")))
                            File.Delete(path);
                        else
                            File.WriteAllText(path, updated + (updated.Length > 0 ? "\n" : ""), new UTF8Encoding(false));
                    }
                }
                else
                {
                    string? dir = Path.GetDirectoryName(path);
                    if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                    string existing = File.Exists(path) ? File.ReadAllText(path, Encoding.UTF8) : "";
                    int s = existing.IndexOf(HookHeader, StringComparison.Ordinal);
                    int e = existing.IndexOf(HookFooter, StringComparison.Ordinal);
                    if (s >= 0 && e > s)
                        existing = (existing[..s] + existing[(e + HookFooter.Length)..]).TrimEnd();
                    string block = $"{HookHeader}\n# Delegator\nUse `{entry}` with `-PromptFile \"<utf8-temp-file>\"`:\n- Auto routing: `assist -CallerModel \"<your model id>\" -PromptFile \"<file>\"`\n- Specific web model (strict mode, returns `[THOUGHTS]` + `[RESPONSE]`): `argon` (AI Studio), `ask -Model deepseek`, `ask -Model qwen`, `ask -Model glm`, or `boost` (2-model council).\n{HookFooter}\n";
                    string combined = string.IsNullOrWhiteSpace(existing) ? block : existing.TrimEnd() + "\n\n" + block;
                    File.WriteAllText(path, combined, new UTF8Encoding(false));
                }
            }
            catch { }
        }
    }

    public static void RemoveAllHooks(string installRoot)
    {
        foreach (var (key, _) in IdeList)
            ApplyHook(key, false, installRoot);
    }
}

internal static class ThinkingReader
{
    public static JsonArray ReadTraces()
    {
        var traces = new JsonArray();
        try
        {
            string rt = ConfigStore.RuntimeHome;
            string routerPath = Path.Combine(rt, "router-decisions.jsonl");
            string metricsPath = Path.Combine(rt, "delegate-metrics.jsonl");
            string thinkingPath = Path.Combine(rt, "thinking-traces.jsonl");

            var map = new Dictionary<string, JsonObject>();
            var order = new List<string>();
            int anonSeq = 0;

            void Upsert(string key, string ts, string provider, string model, string reason, string thoughts = "")
            {
                if (!map.TryGetValue(key, out var trace))
                {
                    trace = new JsonObject
                    {
                        ["id"] = key.Length > 8 ? key[..8] : key,
                        ["time"] = FormatTime(ts),
                        ["provider"] = provider,
                        ["model"] = model,
                        ["reason"] = reason,
                        ["thoughts"] = thoughts
                    };
                    map[key] = trace;
                    order.Add(key);
                }
                else
                {
                    if (!string.IsNullOrWhiteSpace(ts)) trace["time"] = FormatTime(ts);
                    if (!string.IsNullOrWhiteSpace(provider) && provider != "router") trace["provider"] = provider;
                    if (!string.IsNullOrWhiteSpace(model)) trace["model"] = model;
                    if (!string.IsNullOrWhiteSpace(reason))
                    {
                        string prev = trace["reason"]?.GetValue<string>() ?? "";
                        trace["reason"] = string.IsNullOrWhiteSpace(prev) ? reason : $"{prev} · {reason}";
                    }
                    if (!string.IsNullOrWhiteSpace(thoughts)) trace["thoughts"] = thoughts;
                }
            }

            foreach (var line in ReadTailLines(routerPath, 100))
            {
                try
                {
                    var obj = JsonNode.Parse(line) as JsonObject;
                    if (obj == null) continue;
                    string reqId = obj["requestId"]?.GetValue<string>() ?? $"rt-{++anonSeq}";
                    string mode = obj["mode"]?.GetValue<string>() ?? "delegate";
                    string rsn = obj["reason"]?.GetValue<string>() ?? "";
                    long ms = obj["routeMs"]?.GetValue<long>() ?? 0;
                    string ts = obj["ts"]?.GetValue<string>() ?? "";
                    Upsert(reqId, ts, "router", mode, $"Маршрут: {mode} ({rsn}, {ms} мс)");
                }
                catch { }
            }

            foreach (var line in ReadTailLines(metricsPath, 120))
            {
                try
                {
                    var obj = JsonNode.Parse(line) as JsonObject;
                    if (obj == null) continue;
                    string stage = obj["stage"]?.GetValue<string>() ?? "";
                    if (stage != "web" && stage != "web-boost" && stage != "solve" && stage != "improve" && stage != "cache-hit")
                        continue;
                    string status = obj["status"]?.GetValue<string>() ?? "";
                    string model = obj["model"]?.GetValue<string>() ?? stage;
                    string backend = obj["backend"]?.GetValue<string>() ?? "web";
                    long ms = obj["latencyMs"]?.GetValue<long>() ?? 0;
                    string ts = obj["ts"]?.GetValue<string>() ?? "";
                    string reqId = obj["requestId"]?.GetValue<string>() ?? $"mt-{ts}";
                    double sec = Math.Round(ms / 1000.0, 1);
                    Upsert(reqId, ts, $"{backend}: {model}", model, $"[{stage}] {model} — {status} ({sec} с)");
                }
                catch { }
            }

            foreach (var line in ReadTailLines(thinkingPath, 80))
            {
                try
                {
                    var obj = JsonNode.Parse(line) as JsonObject;
                    if (obj == null) continue;
                    string ts = obj["ts"]?.GetValue<string>() ?? "";
                    string reqId = obj["requestId"]?.GetValue<string>() ?? "";
                    string key = !string.IsNullOrWhiteSpace(reqId) ? reqId : $"th-{ts}";
                    string model = obj["model"]?.GetValue<string>() ?? "web";
                    string provider = obj["provider"]?.GetValue<string>() ?? "Web";
                    long ms = obj["elapsedMs"]?.GetValue<long>() ?? 0;
                    string thoughts = obj["thoughts"]?.GetValue<string>() ?? "";
                    string preview = obj["responsePreview"]?.GetValue<string>() ?? "";
                    double sec = Math.Round(ms / 1000.0, 1);
                    string summary = !string.IsNullOrWhiteSpace(preview)
                        ? $"Ответ ({sec} с): {preview}"
                        : $"Ответ получен за {sec} с";
                    Upsert(key, ts, $"{provider} · {model}", model, summary, thoughts);
                }
                catch { }
            }

            order.Reverse();
            foreach (var id in order)
            {
                if (traces.Count >= 25) break;
                traces.Add(map[id]);
            }
        }
        catch { }
        return traces;
    }

    public static JsonObject BuildStats(JsonNode? coreUsage)
    {
        int totalReqs = 0;
        int cacheHits = 0;
        try
        {
            if (coreUsage is JsonObject cu)
            {
                totalReqs = cu["total_requests"]?.GetValue<int>()
                    ?? cu["delegations"]?.GetValue<int>()
                    ?? 0;
                cacheHits = cu["cache_hits"]?.GetValue<int>() ?? 0;
            }

            string metricsPath = Path.Combine(ConfigStore.RuntimeHome, "delegate-metrics.jsonl");
            DateTimeOffset cutoff = DateTimeOffset.UtcNow.AddDays(-7);
            int metricReqs = 0;
            int metricCache = 0;
            foreach (var line in ReadTailLines(metricsPath, 2000))
            {
                try
                {
                    var obj = JsonNode.Parse(line) as JsonObject;
                    if (obj == null) continue;
                    string tsStr = obj["ts"]?.GetValue<string>() ?? "";
                    if (DateTimeOffset.TryParse(tsStr, out var ts) && ts < cutoff) continue;
                    string stage = obj["stage"]?.GetValue<string>() ?? "";
                    string status = obj["status"]?.GetValue<string>() ?? "";
                    if (stage == "cache-hit" && status == "ok")
                    {
                        metricCache++;
                        metricReqs++;
                    }
                    else if ((stage == "web" || stage == "web-boost" || stage == "solve" || stage == "improve")
                             && status != "failed" && status != "not-connected")
                    {
                        metricReqs++;
                    }
                }
                catch { }
            }
            if (metricReqs > totalReqs) totalReqs = metricReqs;
            if (metricCache > cacheHits) cacheHits = metricCache;
        }
        catch { }

        return new JsonObject
        {
            ["total_requests"] = totalReqs,
            ["cache_hits"] = cacheHits
        };
    }

    private static string FormatTime(string ts)
    {
        if (DateTimeOffset.TryParse(ts, out var dto))
            return dto.ToLocalTime().ToString("dd.MM HH:mm:ss");
        return ts;
    }

    private static IEnumerable<string> ReadTailLines(string path, int maxLines)
    {
        if (!File.Exists(path)) return Array.Empty<string>();
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            long start = Math.Max(0, fs.Length - 131072);
            fs.Seek(start, SeekOrigin.Begin);
            using var sr = new StreamReader(fs, Encoding.UTF8);
            if (start > 0) sr.ReadLine();
            var list = new List<string>();
            string? line;
            while ((line = sr.ReadLine()) != null)
            {
                if (!string.IsNullOrWhiteSpace(line)) list.Add(line);
            }
            return list.Count <= maxLines ? list : list.GetRange(list.Count - maxLines, maxLines);
        }
        catch
        {
            return Array.Empty<string>();
        }
    }
}
