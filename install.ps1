# Scenaria installer (Windows) — single binary, no Node.js required.
#   irm https://raw.githubusercontent.com/<owner>/scenaria/main/install.ps1 | iex
# Options (env): SCENARIA_REPO=owner/repo  SCENARIA_VERSION=0.3.0
$ErrorActionPreference = "Stop"
$repo = if ($env:SCENARIA_REPO) { $env:SCENARIA_REPO } else { "ai-gambit/scenaria" }
$version = if ($env:SCENARIA_VERSION) { $env:SCENARIA_VERSION } else { "latest" }
$asset = "scenaria-windows-x64.zip"
$url = if ($version -eq "latest") { "https://github.com/$repo/releases/latest/download/$asset" } else { "https://github.com/$repo/releases/download/v$version/$asset" }

$dir = Join-Path $env:LOCALAPPDATA "Programs\scenaria"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$zip = Join-Path $env:TEMP "scenaria.zip"
Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $dir -Force
Remove-Item $zip
$exe = Get-ChildItem $dir -Filter "scenaria*.exe" | Select-Object -First 1
if ($exe.Name -ne "scenaria.exe") { Move-Item -Force $exe.FullName (Join-Path $dir "scenaria.exe") }

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$dir*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$dir", "User")
  Write-Host "Added $dir to your PATH (open a new terminal)."
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host "! git was not found — Scenaria needs it for file snapshots: https://git-scm.com/download/win"
}
Write-Host "Installed $dir\scenaria.exe"
Write-Host "Next:  cd your-project; scenaria start"
