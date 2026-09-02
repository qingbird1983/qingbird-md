# Full release packaging: clean install deps, build frontend, bundle NSIS installer.
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)  # project root (scripts/..)

npm ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npx tauri build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

New-Item -ItemType Directory -Force -Path release | Out-Null
Copy-Item "target\release\bundle\nsis\*-setup.exe" release\ -Force
Write-Host "Installer copied to release\: $((Get-ChildItem release\*-setup.exe).Name)"
