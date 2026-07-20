<#
.SYNOPSIS
  Register a Windows Scheduled Task that wakes this machine before the US
  market open and holds it awake through the session, so the Finance Agent job
  runner refreshes during market hours instead of sleeping through them.

.DESCRIPTION
  The runner (FinanceAgentJobs) is only suspended while the laptop sleeps, so a
  machine asleep during market hours produces no refreshes/scan/watchdog
  (observed Fri 2026-07-17: the whole session missed). This task fires daily on
  weekdays with -WakeToRun to wake the machine, then runs scripts/keep-awake.ps1
  (hidden) which holds the system awake until just after the close (16:00 ET,
  computed DST-correctly) and then releases.

  Opt-in: nothing installs this for you -- you run it yourself, from an elevated
  PowerShell (task registration needs it on this machine). Remove it any time
  with scripts/uninstall-wake-task.ps1.

.PARAMETER WakeAt
  Local time to wake, HH:mm. Default 03:10 -- a little before the summer open
  (09:30 ET = 03:30 HST). In winter the open is an hour later (04:30 HST); the
  early wake just holds a bit longer, which is harmless.
#>

param([string]$WakeAt = "03:10")

$ErrorActionPreference = "Stop"

$TaskName = "FinanceAgentWake"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot "data\logs") | Out-Null

$vbs = Join-Path $PSScriptRoot "run-hidden-ps.vbs"
$action = New-ScheduledTaskAction -Execute "wscript.exe" `
    -Argument "`"$vbs`" scripts\keep-awake.ps1 data\logs\wake.log" -WorkingDirectory $ProjectRoot

# Daily at $WakeAt, but only on weekdays (market is closed on weekends; the
# hold script also self-skips Sat/Sun as a belt-and-suspenders guard).
$trigger = New-ScheduledTaskTrigger -Weekly `
    -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At $WakeAt

# -WakeToRun is the whole point: wake the machine to run this. StartWhenAvailable
# so a missed wake (machine off) runs at the next opportunity. 9h limit bounds
# the hold well past any market close in either DST regime.
$settings = New-ScheduledTaskSettingsSet `
    -WakeToRun `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 9)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal `
        -Description "Finance Agent: wake before the US market open and hold awake through the session (scripts/keep-awake.ps1). Logs to data/logs/wake.log." `
        -Force -ErrorAction Stop | Out-Null
} catch {
    Write-Error "Failed to register '$TaskName': $($_.Exception.Message). Try running this from an elevated PowerShell."
    exit 1
}
if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Write-Error "Registration reported no error but '$TaskName' does not exist. Run this from an elevated PowerShell."
    exit 1
}

Write-Host "Registered scheduled task '$TaskName'." -ForegroundColor Green
Write-Host "  - Wakes weekdays at $WakeAt local and holds awake until ~16:05 ET (market close)"
Write-Host "  - Hidden; logs to data\logs\wake.log"
Write-Host "  - Remove it: scripts\uninstall-wake-task.ps1"
Write-Host ""
Write-Host "Two things -WakeToRun depends on -- check these or the wake may not fire:" -ForegroundColor Yellow
Write-Host "  1. 'Allow wake timers' must be ON in the active power plan"
Write-Host "     (powercfg /waketimers should list this task once it's near due)."
Write-Host "  2. Closing the lid can still force sleep regardless -- leave the lid"
Write-Host "     open, or set 'do nothing' on lid close, during market hours."
