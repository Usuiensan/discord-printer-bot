param(
  [string]$TaskName = "Discord Printer Bot",
  [switch]$StopBot
)

$ErrorActionPreference = "Stop"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed startup task: $TaskName"
} else {
  Write-Host "Startup task was not found: $TaskName"
}

if ($StopBot) {
  & (Join-Path $PSScriptRoot "stop-bot.ps1")
}
