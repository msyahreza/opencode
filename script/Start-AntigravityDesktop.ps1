param([switch]$Rebuild)

$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
$desktopPath = Join-Path $repoPath 'packages\desktop'
$scratchPath = Join-Path $repoPath 'tmp\antigravity-build'
$bunPath = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
if (-not (Test-Path -LiteralPath $bunPath)) { $bunPath = (Get-Command bun -ErrorAction Stop).Source }
$electronPath = Join-Path $desktopPath 'node_modules\electron\dist\electron.exe'
$cliPath = Join-Path $desktopPath 'resources\opencode-cli.exe'
$sdkPath = Join-Path $desktopPath 'resources\antigravity-sdk.mjs'
$pluginPath = Join-Path $desktopPath 'resources\antigravity-plugin'

try {
    New-Item -ItemType Directory -Path $scratchPath -Force | Out-Null
    $env:TEMP = $scratchPath
    $env:TMP = $scratchPath
    $env:BUN_INSTALL_CACHE_DIR = Join-Path $scratchPath 'bun-cache'
    $env:electron_config_cache = Join-Path $scratchPath 'electron-cache'
    $env:OPENCODE_CHANNEL = 'dev'
    $env:OPENCODE_ANTIGRAVITY_BUILD = '1'
    $env:OPENCODE_VERSION = '2.0.20'
    Push-Location $repoPath
    try {
        if (-not (Test-Path -LiteralPath (Join-Path $desktopPath 'node_modules\electron\install.js'))) {
            & $bunPath install --frozen-lockfile --ignore-scripts
            if ($LASTEXITCODE -ne 0) { throw 'Instalasi dependency desktop 2.0 gagal.' }
        }
        if (-not (Test-Path -LiteralPath $electronPath)) {
            $nodePath = (Get-Command node -ErrorAction Stop).Source
            & $nodePath (Join-Path $desktopPath 'node_modules\electron\install.js')
            if ($LASTEXITCODE -ne 0) { throw 'Download runtime Electron gagal.' }
        }
        if (-not (Test-Path -LiteralPath $cliPath)) {
            $cliScratchPath = Join-Path $repoPath 'tmp\cli-runtime'
            New-Item -ItemType Directory -Path $cliScratchPath -Force | Out-Null
            Set-Content -LiteralPath (Join-Path $cliScratchPath 'package.json') -Value '{"name":"antigravity-v2-cli","private":true}'
            & $bunPath install --cwd $cliScratchPath --ignore-scripts --no-save '@opencode/cli-windows-x64-baseline@2.0.20'
            if ($LASTEXITCODE -ne 0) { throw 'Download runtime OpenCode 2.0 gagal.' }
            Copy-Item -LiteralPath (Join-Path $cliScratchPath 'node_modules\@opencode\cli-windows-x64-baseline\bin\opencode.exe') -Destination $cliPath -Force
            Set-Content -LiteralPath (Join-Path $desktopPath 'resources\opencode-cli.version') -Value '2.0.20' -NoNewline
        }
        if ($Rebuild -or -not (Test-Path -LiteralPath $sdkPath)) {
            & $bunPath build --target=bun --format=esm --outfile $sdkPath (Join-Path $repoPath 'packages\core\src\plugin\provider\antigravity-sdk.ts')
            if ($LASTEXITCODE -ne 0) { throw 'Build adapter Antigravity gagal.' }
        }
        if ($Rebuild -or -not (Test-Path -LiteralPath (Join-Path $pluginPath 'index.js'))) {
            & $bunPath (Join-Path $repoPath 'packages\core\script\build-antigravity.ts') (Join-Path $pluginPath 'index.js')
            if ($LASTEXITCODE -ne 0) { throw 'Build plugin OAuth Antigravity gagal.' }
        }
        Set-Content -LiteralPath (Join-Path $pluginPath 'package.json') -Value '{"name":"opencode-antigravity-oauth","private":true,"type":"module","main":"index.js"}'
        if ($Rebuild -or -not (Test-Path -LiteralPath (Join-Path $desktopPath 'out\main\index.js'))) {
            Push-Location $desktopPath
            try {
                & $bunPath x electron-vite build
                if ($LASTEXITCODE -ne 0) { throw 'Build desktop OpenCode 2.0 gagal.' }
            } finally { Pop-Location }
        }
        $iconsPath = Join-Path $desktopPath 'resources\icons'
        New-Item -ItemType Directory -Path $iconsPath -Force | Out-Null
        Get-ChildItem -LiteralPath (Join-Path $desktopPath 'icons\dev') | Copy-Item -Destination $iconsPath -Recurse -Force
    } finally { Pop-Location }

    $profilePath = Join-Path $env:LOCALAPPDATA 'OpenCode-Antigravity-2.0'
    $env:OPENCODE_DESKTOP_USER_DATA = Join-Path $profilePath 'desktop'
    New-Item -ItemType Directory -Path $env:OPENCODE_DESKTOP_USER_DATA -Force | Out-Null
    foreach ($kind in @('config', 'data', 'cache', 'state')) {
        $targetPath = Join-Path $profilePath $kind
        New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
        [Environment]::SetEnvironmentVariable("XDG_$($kind.ToUpper())_HOME", $targetPath, 'Process')
    }
    $env:OPENCODE_DESKTOP_PRIVATE_SIDECAR = '1'
    & $bunPath (Join-Path $repoPath 'packages\core\script\prepare-antigravity.ts') $env:XDG_CONFIG_HOME $pluginPath $sdkPath
    if ($LASTEXITCODE -ne 0) { throw 'Konfigurasi OAuth Antigravity gagal.' }
    $env:OPENCODE_CONFIG = Join-Path $env:XDG_CONFIG_HOME 'opencode\opencode.json'
    foreach ($key in @('ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'OPENCODE_TEST_ONBOARDING', 'OPENCODE_DESKTOP_TEST_ROOT', 'OPENCODE_DESKTOP_CLI_DEV', 'OPENCODE_DESKTOP_ISOLATED_SERVER', 'OPENCODE_DB', 'OPENCODE_ANTIGRAVITY_OAUTH_READY', 'OPENCODE_ANTIGRAVITY_AUTH_DATABASE')) {
        Remove-Item "Env:$key" -ErrorAction SilentlyContinue
    }
    $env:OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT = '0'
    $status = & $cliPath service status
    if ($LASTEXITCODE -ne 0) { throw 'Pemeriksaan runtime OpenCode 2.0 gagal.' }
    if ($status.Trim() -eq 'stopped') {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $privatePort = $listener.LocalEndpoint.Port
        $listener.Stop()
        & $cliPath service set port "$privatePort"
        if ($LASTEXITCODE -ne 0) { throw 'Konfigurasi port privat gagal.' }
    }
    Write-Host 'Membuka desktop OpenCode 2.0.20 dengan Antigravity...'
    Start-Process -FilePath $electronPath -ArgumentList '.' -WorkingDirectory $desktopPath
    exit 0
} catch {
    Write-Error $_
    exit 1
}
