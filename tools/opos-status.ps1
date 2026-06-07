param(
  [Parameter(Mandatory=$true)]
  [string]$LogicalName,

  [int]$ClaimTimeoutMs = 1000
)

$ErrorActionPreference = "Stop"

try {
  Add-Type -AssemblyName Microsoft.PointOfService
} catch {
  throw "Microsoft.PointOfService assembly was not found. Install EPSON OPOS ADK for .NET and POS for .NET."
}

$explorer = New-Object Microsoft.PointOfService.PosExplorer
$deviceInfo = $explorer.GetDevice("PosPrinter", $LogicalName)
if (-not $deviceInfo) {
  throw "OPOS POSPrinter was not found: $LogicalName"
}

$printer = $explorer.CreateInstance($deviceInfo)

try {
  $printer.Open()
  $printer.Claim($ClaimTimeoutMs)
  $printer.DeviceEnabled = $true

  $status = [pscustomobject]@{
    LogicalName = $LogicalName
    State = [string]$printer.State
    Claimed = [bool]$printer.Claimed
    DeviceEnabled = [bool]$printer.DeviceEnabled
    CoverOpen = if ($printer.PSObject.Properties.Name -contains "CoverOpen") { [bool]$printer.CoverOpen } else { $null }
    RecEmpty = if ($printer.PSObject.Properties.Name -contains "RecEmpty") { [bool]$printer.RecEmpty } else { $null }
    RecNearEnd = if ($printer.PSObject.Properties.Name -contains "RecNearEnd") { [bool]$printer.RecNearEnd } else { $null }
    CheckHealthText = $null
  }

  try {
    $printer.CheckHealth([Microsoft.PointOfService.HealthCheckLevel]::External)
    $status.CheckHealthText = [string]$printer.CheckHealthText
  } catch {
    $status.CheckHealthText = $_.Exception.Message
  }

  $status | ConvertTo-Json -Compress
} finally {
  if ($printer) {
    try {
      if ($printer.DeviceEnabled) {
        $printer.DeviceEnabled = $false
      }
    } catch {}
    try {
      if ($printer.Claimed) {
        $printer.Release()
      }
    } catch {}
    try {
      $printer.Close()
    } catch {}
  }
}
