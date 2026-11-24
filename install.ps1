# Scenaria installer (Windows) — single binary, no Node.js required.
#   irm https://raw.githubusercontent.com/<owner>/scenaria/main/install.ps1 | iex
# The download is checked against the release's SHA256SUMS before it is installed.
# Options (env): SCENARIA_REPO=owner/repo  SCENARIA_VERSION=0.9.24
$ErrorActionPreference = "Stop"
$repo = if ($env:SCENARIA_REPO) { $env:SCENARIA_REPO } else { "aigambitkg/scenaria" }
$version = if ($env:SCENARIA_VERSION) { $env:SCENARIA_VERSION } else { "latest" }
$asset = "scenaria-windows-x64.zip"
$url = if ($version -eq "latest") { "https://github.com/$repo/releases/latest/download/$asset" } else { "https://github.com/$repo/releases/download/v$version/$asset" }

$dir = Join-Path $env:LOCALAPPDATA "Programs\scenaria"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$zip = Join-Path $env:TEMP "scenaria.zip"
Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $zip

# Check the download against the release's SHA256SUMS before anything is unpacked or run.
if ($env:SCENARIA_SKIP_VERIFY -eq "1") {
  Write-Host "! Skipping the checksum check (SCENARIA_SKIP_VERIFY=1)."
} else {
  $sumsUrl = $url.Substring(0, $url.LastIndexOf("/")) + "/SHA256SUMS"
  $sumsFile = Join-Path $env:TEMP "scenaria-SHA256SUMS"
  try { Invoke-WebRequest -Uri $sumsUrl -OutFile $sumsFile } catch { Remove-Item $zip -Force; throw "Could not download SHA256SUMS ($sumsUrl). Nothing was installed." }
  $want = $null
  foreach ($line in Get-Content $sumsFile) {
    $parts = $line.Trim() -split "\s+", 2
    if ($parts.Count -eq 2 -and $parts[1].TrimStart("*") -eq $asset) { $want = $parts[0].ToLower() }
  }
  Remove-Item $sumsFile -Force
  if (-not $want) { Remove-Item $zip -Force; throw "SHA256SUMS has no entry for $asset. Nothing was installed." }
  $got = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $want) { Remove-Item $zip -Force; throw "Checksum mismatch for $asset (expected $want, got $got). Nothing was installed." }
  Write-Host "Checksum matches SHA256SUMS"
}
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
