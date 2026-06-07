$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$PidPath = Join-Path $ProjectRoot "run\discord-printer-bot.pid"

if (-not (Test-Path -LiteralPath $PidPath)) {
  Write-Host "Discord printer bot PID file was not found."
  exit 0
}

$rawPid = (Get-Content -Raw -LiteralPath $PidPath).Trim()
if (-not ($rawPid -match "^\d+$")) {
  Remove-Item -LiteralPath $PidPath -Force
  Write-Host "Removed invalid PID file."
  exit 0
}

$process = Get-Process -Id ([int]$rawPid) -ErrorAction SilentlyContinue
if ($process) {
  Stop-Process -Id $process.Id -Force
  Write-Host "Stopped Discord printer bot. PID: $($process.Id)"
} else {
  Write-Host "Discord printer bot was not running."
}

Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
