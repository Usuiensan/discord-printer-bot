param(
  [Parameter(Mandatory=$true)]
  [string]$LogicalName,

  [int]$ClaimTimeoutMs = 1000
)

$ErrorActionPreference = "Stop"

try {
  Add-Type -AssemblyName Microsoft.PointOfService -ErrorAction Stop
} catch {
  $pointOfServiceDll = @(
    "$env:WINDIR\Microsoft.NET\assembly\GAC_MSIL\Microsoft.PointOfService\v4.0_*\Microsoft.PointOfService.dll",
    "$env:WINDIR\assembly\GAC_MSIL\Microsoft.PointOfService\*\Microsoft.PointOfService.dll",
    "$env:ProgramFiles\Microsoft Point Of Service\*\Microsoft.PointOfService.dll",
    "${env:ProgramFiles(x86)}\Microsoft Point Of Service\*\Microsoft.PointOfService.dll"
  ) |
    ForEach-Object { Get-ChildItem -Path $_ -ErrorAction SilentlyContinue } |
    Sort-Object FullName -Descending |
    Select-Object -First 1

  if (-not $pointOfServiceDll) {
    throw "Microsoft.PointOfService.dll was not found. Install Microsoft POS for .NET."
  }

  Add-Type -Path $pointOfServiceDll.FullName -ErrorAction Stop
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
    $null = $printer.CheckHealth([Microsoft.PointOfService.HealthCheckLevel]::Internal)
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
