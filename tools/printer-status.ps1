param(
  [Parameter(Mandatory=$true)]
  [string]$PrinterName
)

$ErrorActionPreference = "Stop"

$printer = $null
try {
  $printer = Get-Printer -Name $PrinterName -ErrorAction Stop
} catch {
  $printer = $null
}

$wmi = $null
try {
  $wmi = Get-CimInstance Win32_Printer -ErrorAction Stop | Where-Object { $_.Name -eq $PrinterName } | Select-Object -First 1
} catch {
  $wmi = $null
}

if (-not $wmi) {
  try {
    $wmi = Get-WmiObject Win32_Printer -ErrorAction Stop | Where-Object { $_.Name -eq $PrinterName } | Select-Object -First 1
  } catch {
    $wmi = $null
  }
}

if (-not $printer -and -not $wmi) {
  throw "Printer was not found: $PrinterName"
}

$status = [pscustomobject]@{
  Name = if ($printer) { $printer.Name } else { $wmi.Name }
  PrinterStatus = if ($printer) { [string]$printer.PrinterStatus } else { [string]$wmi.PrinterStatus }
  WorkOffline = if ($printer) { [bool]$printer.WorkOffline } else { [bool]$wmi.WorkOffline }
  Paused = if ($printer) { [bool]$printer.Paused } else { [bool]$wmi.Paused }
  JobCount = if ($printer) { [int]$printer.JobCount } else { 0 }
  DetectedErrorState = if ($wmi) { [int]$wmi.DetectedErrorState } else { 0 }
  ExtendedPrinterStatus = if ($wmi) { [int]$wmi.ExtendedPrinterStatus } else { 0 }
  PrinterState = if ($wmi) { [int]$wmi.PrinterState } else { 0 }
}

$status | ConvertTo-Json -Compress
