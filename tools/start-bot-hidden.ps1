param(
  [switch]$Restart
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$RunDir = Join-Path $ProjectRoot "run"
$LogDir = Join-Path $ProjectRoot "logs"
$PidPath = Join-Path $RunDir "discord-printer-bot.pid"
$OutLog = Join-Path $LogDir "discord-printer-bot.out.log"
$ErrLog = Join-Path $LogDir "discord-printer-bot.err.log"

New-Item -ItemType Directory -Force -Path $RunDir, $LogDir | Out-Null

function Get-ExistingBotProcess {
  if (-not (Test-Path -LiteralPath $PidPath)) {
    return $null
  }

  $rawPid = (Get-Content -Raw -LiteralPath $PidPath).Trim()
  if (-not ($rawPid -match "^\d+$")) {
    return $null
  }

  return Get-Process -Id ([int]$rawPid) -ErrorAction SilentlyContinue
}

$existing = Get-ExistingBotProcess
if ($existing) {
  if (-not $Restart) {
    Write-Host "Discord printer bot is already running. PID: $($existing.Id)"
    exit 0
  }

  Stop-Process -Id $existing.Id -Force
  Start-Sleep -Seconds 1
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
}
if (-not $nodeCommand) {
  throw "node.exe was not found. Install Node.js 20 or later and make sure node is in PATH."
}

$process = Start-Process `
  -FilePath $nodeCommand.Source `
  -ArgumentList @("src/index.js") `
  -WorkingDirectory $ProjectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog `
  -PassThru

Set-Content -LiteralPath $PidPath -Value $process.Id -Encoding ASCII
Write-Host "Started Discord printer bot hidden. PID: $($process.Id)"
