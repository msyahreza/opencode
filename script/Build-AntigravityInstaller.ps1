param([string]$Version)

$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
$desktopPath = Join-Path $repoPath 'packages\desktop'
$scratchPath = Join-Path $repoPath 'tmp\installer-build'
$bunPath = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
if (-not (Test-Path -LiteralPath $bunPath)) { $bunPath = (Get-Command bun -ErrorAction Stop).Source }
$metadata = Get-Content -Raw -LiteralPath (Join-Path $desktopPath 'package.json') | ConvertFrom-Json
if (-not $Version) { $Version = "$($metadata.version)-antigravity.3" }

New-Item -ItemType Directory -Path $scratchPath -Force | Out-Null
$env:TEMP = $scratchPath
$env:TMP = $scratchPath
$env:ELECTRON_BUILDER_CACHE = Join-Path $scratchPath 'builder-cache'
$env:electron_config_cache = Join-Path $scratchPath 'electron-cache'
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
$env:OPENCODE_CHANNEL = 'dev'
$env:OPENCODE_VERSION = $Version
$env:OPENCODE_ANTIGRAVITY_BUILD = '1'
$env:OPENCODE_ANTIGRAVITY_RELEASE_VERSION = $Version
$env:OPENCODE_CLI_TARGET = 'x86_64-pc-windows-msvc'
Push-Location $desktopPath
try {
    $cliVersionPath = Join-Path $desktopPath 'resources\opencode-cli.version'
    $cliPath = Join-Path $desktopPath 'resources\opencode-cli.exe'
    $cliVersion = if (Test-Path -LiteralPath $cliVersionPath) { (Get-Content -Raw -LiteralPath $cliVersionPath).Trim() } else { '' }
    if (-not (Test-Path -LiteralPath $cliPath) -or $cliVersion -ne $metadata.version) {
        & $bunPath -e 'const { downloadCliToResources } = await import("./scripts/utils.ts"); await downloadCliToResources(process.argv[1])' $metadata.version
        if ($LASTEXITCODE -ne 0) { throw 'Persiapan CLI sesuai versi desktop gagal.' }
    }
    & $bunPath ./scripts/copy-icons.ts dev
    if ($LASTEXITCODE -ne 0) { throw 'Persiapan ikon desktop gagal.' }
    & $bunPath build --target=bun --format=esm --outfile resources/antigravity-sdk.mjs (Join-Path $repoPath 'packages\core\src\plugin\provider\antigravity-sdk.ts')
    if ($LASTEXITCODE -ne 0) { throw 'Build SDK Antigravity gagal.' }
    & $bunPath (Join-Path $repoPath 'packages\core\script\build-antigravity.ts') resources/antigravity-plugin/index.js
    if ($LASTEXITCODE -ne 0) { throw 'Build plugin OAuth gagal.' }
    Set-Content -LiteralPath resources/antigravity-plugin/package.json -Value '{"name":"opencode-antigravity-oauth","private":true,"type":"module","main":"index.js"}'
    & $bunPath x electron-vite build
    if ($LASTEXITCODE -ne 0) { throw 'Build desktop gagal.' }
    & $bunPath x electron-builder --win --x64 --config electron-builder.antigravity.config.ts --publish never
    if ($LASTEXITCODE -ne 0) { throw 'Packaging installer gagal.' }
    Get-ChildItem -LiteralPath dist-antigravity -Filter '*.exe' | Select-Object FullName,Length
} finally { Pop-Location }
