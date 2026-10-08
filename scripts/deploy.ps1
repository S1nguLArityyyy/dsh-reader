# Build and deploy to D:\DshReaderApp
#
# Why a separate script: make-portable.mjs deploys with fs.cpSync, which kills the
# Node process while copying the 234MB exe (it prints "deploy attempt 1" and then
# dies without reaching its catch, leaving an emptied deploy directory). This uses
# robocopy instead - a separate process - and checks its exit code.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$deployDir = if ($env:DSH_DEPLOY_DIR) { $env:DSH_DEPLOY_DIR } else { 'D:\DshReaderApp' }

# Make make-portable.mjs skip its own deploy step (a deploy dir inside the project is skipped)
$env:DSH_DEPLOY_DIR = Join-Path $root 'release'

$running = @(Get-Process -Name 'DshReader' -ErrorAction SilentlyContinue).Count
if ($running -gt 0) {
  Write-Host "App is running ($running processes). Close it before packaging." -ForegroundColor Yellow
  exit 1
}

$javaHome = 'D:\java\java21'
if (Test-Path $javaHome) {
  $env:JAVA_HOME = $javaHome
  $env:PATH = "$javaHome\bin;$env:PATH"
}

Write-Host 'Building...'
Push-Location $root
try {
  # npm writes warnings to stderr; with ErrorActionPreference=Stop that would abort the script
  $ErrorActionPreference = 'Continue'
  npm run dist 2>&1 | Out-Null
  $ErrorActionPreference = 'Stop'
} finally {
  Pop-Location
}

$staging = Get-ChildItem (Join-Path $root 'release') -Directory -Filter 'DshReader-*-portable' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $staging) { throw 'No build output directory found' }
if (-not (Test-Path (Join-Path $staging.FullName 'resources\app.asar'))) { throw 'Build output has no app.asar' }

Write-Host "Deploying: $($staging.FullName) -> $deployDir"
# robocopy exit codes 0-7 mean success, >=8 means failure
$res = Start-Process -FilePath 'robocopy' `
  -ArgumentList @($staging.FullName, $deployDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:2', '/W:1') `
  -Wait -PassThru -NoNewWindow
if ($res.ExitCode -ge 8) { throw "robocopy failed with exit code $($res.ExitCode)" }

$exe = Join-Path $deployDir 'DshReader.exe'
$asar = Join-Path $deployDir 'resources\app.asar'
$books = @(Get-ChildItem (Join-Path $deployDir 'books') -Filter '*.epub' -ErrorAction SilentlyContinue).Count
if (-not (Test-Path $exe)) { throw 'DshReader.exe missing after deploy' }
if (-not (Test-Path $asar)) { throw 'app.asar missing after deploy' }

Write-Host ''
Write-Host 'Deployed:'
Write-Host "  exe      : $([math]::Round((Get-Item $exe).Length / 1MB, 1))MB  version $((Get-Item $exe).VersionInfo.FileVersion)"
Write-Host "  app.asar : $((Get-Item $asar).LastWriteTime.ToString('HH:mm:ss'))"
Write-Host "  books    : $books files (user data, untouched)"
