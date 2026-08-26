# Build the release binary and, if NSIS (makensis) is present, the Windows installer.
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)  # project root (scripts/..)

cargo build --release
Write-Host "Release binary: $(Join-Path (Get-Location) 'target\release\qingbird-md.exe')"

if (Get-Command makensis -ErrorAction SilentlyContinue) {
    makensis (Join-Path $PSScriptRoot "installer.nsi")
    Write-Host "Installer produced (see makensis output)."
} else {
    Write-Host "NSIS (makensis) not found on PATH. Run 'makensis scripts\installer.nsi' to build the installer."
}
