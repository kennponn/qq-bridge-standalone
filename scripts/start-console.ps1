param(
    [switch]$OpenConsole,
    [string]$NodePath = $env:QQ_BRIDGE_NODE
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$candidates = @()
if ($NodePath) { $candidates += $NodePath }
if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
$command = Get-Command node -ErrorAction SilentlyContinue
if ($command) { $candidates += $command.Source }
$node = $null
foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
        $versionText = (& $candidate --version).Trim().TrimStart('v')
        if ([version]$versionText -ge [version]'22.13.0') { $node = $candidate; break }
    } catch {}
}
if (-not $node) { throw 'Node.js >=22.13.0 is required. Install Node.js or set QQ_BRIDGE_NODE.' }
if (-not (Test-Path -LiteralPath (Join-Path $root 'config.json'))) { throw 'config.json is missing. Copy config.example.json and configure the QQ allowlist first.' }

Set-Location -LiteralPath $root
Write-Host "QQ bridge guard uses Node.js $versionText"
if ($OpenConsole) {
    # A delayed browser opener waits for the bridge to create its local console token.
    $opener = Start-Job -ArgumentList $root -ScriptBlock {
        param($projectRoot)
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            try {
                $cfg = Get-Content -LiteralPath (Join-Path $projectRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
                $port = 3100
                if ($null -ne $cfg.consolePort) { $port = [int]$cfg.consolePort }
                if ($port -lt 1 -or $port -gt 65535) { return }
                $token = [string]$cfg.consoleToken
                $tokenFile = Join-Path $projectRoot 'state\console-token'
                if (-not $token -and (Test-Path -LiteralPath $tokenFile)) { $token = (Get-Content -LiteralPath $tokenFile -Raw).Trim() }
                if ($token) {
                    $base = "http://127.0.0.1:$port"
                    $request = [Net.HttpWebRequest]::Create("$base/api/status")
                    $request.Proxy = $null
                    $request.Timeout = 2000
                    $request.Headers.Add('x-console-token', $token)
                    $response = $request.GetResponse()
                    $response.Close()
                    Start-Process -FilePath ($base + '/?token=' + [Uri]::EscapeDataString($token)) -WindowStyle Normal
                    return
                }
            } catch {}
            Start-Sleep -Seconds 1
        }
    }
}

try {
    while ($true) {
        & $node (Join-Path $root 'src\bridge.js')
        $code = $LASTEXITCODE
        if ($code -eq 2) { Write-Host 'A QQ bridge instance is already running; no duplicate was started.'; break }
        Write-Host "Bridge exited with code $code; restarting in 5 seconds. Press Ctrl+C to stop."
        Start-Sleep -Seconds 5
    }
} finally {
    if ($opener) { Stop-Job -Job $opener -ErrorAction SilentlyContinue; Remove-Job -Job $opener -Force -ErrorAction SilentlyContinue }
}
