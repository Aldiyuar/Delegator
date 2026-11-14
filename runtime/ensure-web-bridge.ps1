param(
    [switch]$Watch
)

$ErrorActionPreference = "SilentlyContinue"
$CoreUrl = "http://127.0.0.1:1380"
$DebugPort = 9239
$ProfileDir = Join-Path $env:LOCALAPPDATA "Delegator\chrome-profile"
if (Test-Path (Join-Path $PSScriptRoot "..\extensions\gemini-web-bridge")) {
    $ExtensionDir = (Resolve-Path (Join-Path $PSScriptRoot "..\extensions\gemini-web-bridge")).Path
} else {
    $ExtensionDir = Join-Path $env:LOCALAPPDATA "Programs\Delegator\extensions\gemini-web-bridge"
}

function Start-DetachedProcess {
    param(
        [string]$CommandLine,
        [bool]$Hidden = $false
    )
    try {
        $props = @{}
        if ($Hidden) {
            $props["ShowWindow"] = [uint16]0 # SW_HIDE
        }
        $startup = New-CimInstance -ClassName Win32_ProcessStartup -Property $props -ClientOnly
        $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
            CommandLine = $CommandLine
            ProcessStartupInformation = $startup
        }
        return $res.ProcessId
    } catch {
        return $null
    }
}

function Find-ChromeBinary {
    $candidates = @(
        "C:\Program Files\Google\Chrome\Application\chrome.exe",
        "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe"),
        "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    )
    foreach ($p in $candidates) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    return $null
}

function Send-CdpCommand {
    param(
        [string]$WsUrl,
        [string]$PayloadJson,
        [int]$TimeoutMs = 5000
    )
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $cts = New-Object System.Threading.CancellationTokenSource($TimeoutMs)
    try {
        $uri = [System.Uri]::new($WsUrl)
        $ws.ConnectAsync($uri, $cts.Token).GetAwaiter().GetResult()
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($PayloadJson)
        $segment = New-Object System.ArraySegment[byte]($bytes, 0, $bytes.Length)
        $ws.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).GetAwaiter().GetResult()

        $buf = New-Object byte[] 16384
        $recvSeg = New-Object System.ArraySegment[byte]($buf, 0, $buf.Length)
        $res = $ws.ReceiveAsync($recvSeg, $cts.Token).GetAwaiter().GetResult()
        if ($res.Count -gt 0) {
            return [System.Text.Encoding]::UTF8.GetString($buf, 0, $res.Count)
        }
        return ""
    } catch {
        return $null
    } finally {
        try {
            if ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
                $closeCts = New-Object System.Threading.CancellationTokenSource(1000)
                $ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "done", $closeCts.Token).GetAwaiter().GetResult()
            }
        } catch {}
        try { $ws.Dispose() } catch {}
        try { $cts.Dispose() } catch {}
    }
}

function Stop-DelegatorChrome {
    Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -and ($_.CommandLine -match "Delegator\\chrome-profile" -or $_.CommandLine -match "--remote-debugging-port=$DebugPort")
    } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Ensure-DelegatorWebBridge {
    try {
        $doors = Invoke-RestMethod -Uri "$CoreUrl/api/web/doors" -TimeoutSec 2 -ErrorAction Stop
        if ($doors.connected) { return $true }
        if ($doors.paused) { return $false }
    } catch {
        return $false
    }

    $chromeExe = Find-ChromeBinary
    if (-not $chromeExe -or -not (Test-Path -LiteralPath $ExtensionDir)) {
        return $false
    }

    if (-not (Test-Path -LiteralPath $ProfileDir)) {
        New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
    }

    # Check if CDP port 9239 is already responding
    $ver = $null
    try {
        $ver = Invoke-RestMethod -Uri "http://127.0.0.1:$DebugPort/json/version" -TimeoutSec 1 -ErrorAction Stop
    } catch {
        $ver = $null
    }

    if ($null -eq $ver -or -not $ver.webSocketDebuggerUrl) {
        $running = Get-CimInstance Win32_Process | Where-Object {
            $_.CommandLine -and $_.CommandLine -match "Delegator\\chrome-profile"
        }
        if (-not $running) {
            foreach ($lf in @("SingletonLock", "SingletonCookie", "SingletonSocket")) {
                $lp = Join-Path $ProfileDir $lf
                if (Test-Path -LiteralPath $lp) {
                    Remove-Item -LiteralPath $lp -Force -ErrorAction SilentlyContinue
                }
            }
        }

        $cmdLine = "`"$chromeExe`" --user-data-dir=`"$ProfileDir`" --remote-debugging-port=$DebugPort --enable-unsafe-extension-debugging --no-first-run --no-default-browser-check --window-position=-2400,-2400 --window-size=1440,900 --disable-blink-features=AutomationControlled --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding about:blank"
        $null = Start-DetachedProcess -CommandLine $cmdLine -Hidden $false

        for ($i = 0; $i -lt 24; $i++) {
            Start-Sleep -Milliseconds 250
            try {
                $ver = Invoke-RestMethod -Uri "http://127.0.0.1:$DebugPort/json/version" -TimeoutSec 1 -ErrorAction Stop
                if ($ver -and $ver.webSocketDebuggerUrl) { break }
            } catch {}
        }
    }

    if ($ver -and $ver.webSocketDebuggerUrl) {
        $escapedPath = $ExtensionDir.Replace('\', '\\')
        $cmd = "{`"id`":1,`"method`":`"Extensions.loadUnpacked`",`"params`":{`"path`":`"$escapedPath`"}}"
        $null = Send-CdpCommand -WsUrl $ver.webSocketDebuggerUrl -PayloadJson $cmd -TimeoutMs 5000
    }

    for ($w = 0; $w -lt 20; $w++) {
        Start-Sleep -Milliseconds 300
        try {
            $doors = Invoke-RestMethod -Uri "$CoreUrl/api/web/doors" -TimeoutSec 2 -ErrorAction Stop
            if ($doors.connected) { return $true }
        } catch {}
    }
    return $false
}

function Start-BridgeWatcherIfNeeded {
    $mutexName = "Local\DelegatorWebBridgeWatcherMutex"
    $createdNew = $false
    $mutex = New-Object System.Threading.Mutex($false, $mutexName, [ref]$createdNew)
    try {
        $acquired = $false
        try {
            $acquired = $mutex.WaitOne(0)
        } catch [System.Threading.AbandonedMutexException] {
            $acquired = $true
        }
        if ($acquired) {
            $mutex.ReleaseMutex()
            $scriptPath = $PSCommandPath
            $watchCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`" -Watch"
            $null = Start-DetachedProcess -CommandLine $watchCmd -Hidden $true
        }
    } finally {
        $mutex.Dispose()
    }
}

if ($Watch) {
    $mutexName = "Local\DelegatorWebBridgeWatcherMutex"
    $createdNew = $false
    $mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
    $ownsMutex = $createdNew
    if (-not $ownsMutex) {
        try {
            $ownsMutex = $mutex.WaitOne(0)
        } catch [System.Threading.AbandonedMutexException] {
            $ownsMutex = $true
        }
    }
    if (-not $ownsMutex) {
        $mutex.Dispose()
        exit 0
    }
    try {
        $missingCoreCount = 0
        while ($true) {
            $coreProc = Get-Process -Name "delegator-core", "delegator" -ErrorAction SilentlyContinue
            if (-not $coreProc) {
                $missingCoreCount++
                if ($missingCoreCount -ge 3) {
                    Stop-DelegatorChrome
                    break
                }
            } else {
                $missingCoreCount = 0
                $null = Ensure-DelegatorWebBridge
            }
            Start-Sleep -Seconds 3
        }
    } finally {
        try { $mutex.ReleaseMutex() } catch {}
        try { $mutex.Dispose() } catch {}
    }
} else {
    Start-BridgeWatcherIfNeeded
    $ok = Ensure-DelegatorWebBridge
    if ($ok) { exit 0 } else { exit 1 }
}
