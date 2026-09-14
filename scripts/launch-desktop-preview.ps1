$ErrorActionPreference = 'Stop'

$projectPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $projectPath

# Tauri must use the same loopback address as Vite in the desktop preview.
$env:TAURI_DEV_HOST = '127.0.0.1'

& npm.cmd run tauri dev
exit $LASTEXITCODE
