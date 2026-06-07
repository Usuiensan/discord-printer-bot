param(
  [Parameter(Mandatory=$true)]
  [string]$PrinterName
)

$ErrorActionPreference = "Stop"

$wmi = Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq $PrinterName } | Select-Object -First 1
if (-not $wmi) {
  throw "Printer was not found: $PrinterName"
}

$printer = $null
try {
  $printer = Get-Printer -Name $PrinterName
} catch {
  $printer = $null
}

$status = [pscustomobject]@{
  Name = $wmi.Name
  PrinterStatus = if ($printer) { [string]$printer.PrinterStatus } else { [string]$wmi.PrinterStatus }
  WorkOffline = if ($printer) { [bool]$printer.WorkOffline } else { [bool]$wmi.WorkOffline }
  Paused = if ($printer) { [bool]$printer.Paused } else { [bool]$wmi.Paused }
  JobCount = if ($printer) { [int]$printer.JobCount } else { 0 }
  DetectedErrorState = [int]$wmi.DetectedErrorState
  ExtendedPrinterStatus = [int]$wmi.ExtendedPrinterStatus
  PrinterState = [int]$wmi.PrinterState
}

$status | ConvertTo-Json -Compress
