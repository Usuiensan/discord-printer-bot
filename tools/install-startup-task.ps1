param(
  [string]$TaskName = "Discord Printer Bot"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$StartScript = Join-Path $ProjectRoot "tools\start-bot-hidden.ps1"

if (-not (Test-Path -LiteralPath $StartScript)) {
  throw "Start script was not found: $StartScript"
}

$escapedStartScript = '"' + $StartScript + '"'
$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $escapedStartScript"

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Starts the Discord printer bot hidden when this Windows user logs on." `
  -Force | Out-Null

Write-Host "Installed startup task: $TaskName"
Write-Host "The bot will start hidden the next time this Windows user logs on."
